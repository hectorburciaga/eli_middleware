import * as backend from './backendClient.js';
import { getERPSnapshot } from '../tools/frappe.js';

/**
 * Builds the full context object Claude needs.
 * ERP snapshots are fetched in parallel for every configured connection.
 */
export async function buildContext() {
  const [tasks, projects, connections, settings, summary] = await Promise.all([
    backend.getTasks({ include_done: 0 }),
    backend.getProjects(),
    backend.getConnections(),
    backend.getSettings(),
    backend.getTaskSummary(),
  ]);

  // For each project that has a configured Frappe connection, fetch a snapshot
  const erpData = {};
  const erpFetches = projects
    .filter(p => p.connId)
    .map(async (p) => {
      const conn = connections.find(c => c.id === p.connId);
      if (!conn || conn.typeId !== 'frappe_erp') return;
      const snapshot = await getERPSnapshot(p.connId);
      if (!snapshot.stub) erpData[p.id] = { project: p, snapshot };
    });

  await Promise.allSettled(erpFetches); // never block if an ERP is down

  return { tasks, projects, connections, settings, summary, erpData };
}

/**
 * Formats ERP snapshot data into readable text for Claude's system prompt.
 */
function formatERPSection(erpData) {
  if (!Object.keys(erpData).length) return null;

  const lines = [];
  for (const [projectId, { project, snapshot }] of Object.entries(erpData)) {
    lines.push(`### ${project.name} (ERP live data)`);

    if (snapshot.openProjects.length) {
      lines.push(`**Open projects (${snapshot.openProjects.length}):**`);
      snapshot.openProjects.slice(0, 10).forEach(p =>
        lines.push(`  - ${p.project_name || p.name} · ${p.percent_complete || 0}% complete${p.expected_end_date ? ' · due ' + p.expected_end_date : ''}`)
      );
    }

    if (snapshot.openTasks.length) {
      lines.push(`**Open ERP tasks (${snapshot.openTasks.length}):**`);
      snapshot.openTasks.slice(0, 10).forEach(t =>
        lines.push(`  - [${t.priority || 'Normal'}] ${t.subject}${t.project ? ' · ' + t.project : ''}${t.exp_end_date ? ' · due ' + t.exp_end_date : ''}`)
      );
    }

    if (snapshot.openQuotations.length) {
      lines.push(`**Open quotations (${snapshot.openQuotations.length}):**`);
      snapshot.openQuotations.slice(0, 5).forEach(q =>
        lines.push(`  - ${q.party_name} · ${q.grand_total} ${q.currency}${q.valid_till ? ' · valid till ' + q.valid_till : ''}`)
      );
    }

    if (snapshot.unpaidInvoices.length) {
      lines.push(`**Unpaid invoices (${snapshot.unpaidInvoices.length}):**`);
      snapshot.unpaidInvoices.slice(0, 5).forEach(i =>
        lines.push(`  - ${i.customer} · ${i.outstanding_amount} ${i.currency}${i.due_date ? ' · due ' + i.due_date : ''}`)
      );
    }

    if (snapshot.openIssues.length) {
      lines.push(`**Open issues (${snapshot.openIssues.length}):**`);
      snapshot.openIssues.slice(0, 5).forEach(i =>
        lines.push(`  - [${i.priority || 'Normal'}] ${i.subject}${i.customer ? ' · ' + i.customer : ''}`)
      );
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Builds the system prompt for Claude using live context including ERP data.
 */
export function buildSystemPrompt(ctx) {
  const iLang = ctx.settings?.interactionLang || process.env.USER_INTERACTION_LANG || 'en';
  const oLang = ctx.settings?.outputLang      || process.env.USER_OUTPUT_LANG      || 'es';
  const name  = process.env.USER_NAME         || 'Hector';
  const tz    = process.env.USER_TIMEZONE     || 'America/Monterrey';
  const about = process.env.USER_CONTEXT      || '';

  const projectList = ctx.projects.map(p => {
    const conn = ctx.connections.find(c => c.id === p.connId);
    const erpConnected = ctx.erpData?.[p.id] ? ' ✓ ERP live' : '';
    return `  - ${p.id}: ${p.name}${conn ? ` [${conn.label} · ${conn.typeId}${erpConnected}]` : ' [no connection]'}`;
  }).join('\n');

  const { summary } = ctx;
  const urgentCount   = summary?.counts?.filter(r => r.priority === 'Urgent').reduce((a, r) => a + r.count, 0) || 0;
  const overdueCount  = summary?.overdue?.length || 0;
  const dueTodayCount = summary?.dueToday?.length || 0;

  const erpSection = formatERPSection(ctx.erpData || {});

  return `You are the personal AI assistant of ${name}. ${about}

## Language rules
- Interaction language: ${iLang === 'es' ? 'Spanish' : 'English'}. Always reply to ${name} in this language regardless of what language they write in.
- Output/deliverable language: ${oLang === 'es' ? 'Spanish' : 'English'}. Use this when drafting documents, emails, or any deliverable content unless the task specifies otherwise.

## User timezone
${tz}. Today is ${new Date().toLocaleDateString(iLang === 'es' ? 'es-MX' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })}.

## Projects
${projectList || '  (none configured)'}

## Task manager snapshot
- Urgent tasks:  ${urgentCount}
- Overdue tasks: ${overdueCount}
- Due today:     ${dueTodayCount}
- Total active:  ${ctx.tasks.length}

## Active tasks (JSON)
${JSON.stringify(ctx.tasks, null, 2)}

${erpSection ? `## Live ERP data\nThe following data was fetched in real time from connected ERP instances:\n\n${erpSection}` : '## ERP data\nNo ERP connections are configured yet.'}

## Your capabilities
- Read and manage tasks (create, update, delete)
- Give prioritized daily briefings combining task manager + ERP data
- Answer questions about ERP projects, quotations, invoices, and issues
- Help plan ${name}'s day across all systems
- Draft content in the correct output language

When ${name} asks you to create, update, or delete a task, respond conversationally AND append a single action block:

<action>{"type":"create","task":{"title":"...","priority":"Urgent|Important|Can Wait","projectId":"<id>","status":"Inbox","description":"...","due":"YYYY-MM-DD or null","source":"chat","outputLang":"${oLang}"}}</action>

<action>{"type":"update","id":<number>,"changes":{"status":"...","priority":"..."}}</action>

<action>{"type":"delete","id":<number>}</action>

Only one action block per response. Never fabricate task IDs.

## Write authorization (Phase 4 — not yet active)
ERP writes (creating or updating Frappe records) require explicit user confirmation before execution. If ${name} asks you to write to the ERP, acknowledge the request and state what you would do, but do not execute it yet.

## Tone
Concise and direct. ${name} is a busy professional. Most urgent first. Max 3-4 sentences unless a full summary or draft is requested.`;
}
