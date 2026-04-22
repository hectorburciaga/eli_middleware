import * as backend from './backendClient.js';
import { getERPSnapshot, DOCTYPE_REGISTRY } from '../tools/frappe.js';

export async function buildContext() {
  const [tasks, projects, connections, settings, summary] = await Promise.all([
    backend.getTasks({ include_done: 0 }),
    backend.getProjects(),
    backend.getConnections(),
    backend.getSettings(),
    backend.getTaskSummary(),
  ]);

  // Fetch ERP snapshots in parallel for all configured Frappe connections
  const erpData = {};
  await Promise.allSettled(
    projects
      .filter(p => p.connId)
      .map(async (p) => {
        const conn = connections.find(c => c.id === p.connId);
        if (!conn || conn.typeId !== 'frappe_erp') return;
        const snapshot = await getERPSnapshot(p.connId);
        if (!snapshot.stub) erpData[p.id] = { projectName: p.name, snapshot };
      })
  );

  return { tasks, projects, connections, settings, summary, erpData };
}

function formatERPSection(erpData) {
  if (!Object.keys(erpData).length) return null;
  const lines = [];

  for (const [, { projectName, snapshot }] of Object.entries(erpData)) {
    lines.push(`### ${projectName} — live ERP data`);

    for (const entry of DOCTYPE_REGISTRY) {
      const result = snapshot[entry.id];
      if (!result || !result.data?.length) continue;
      lines.push(`**${entry.label} (${result.data.length}):**`);
      result.data.slice(0, 8).forEach(r => {
        try { lines.push(`  - ${entry.display(r)}`); }
        catch { lines.push(`  - ${r.name}`); }
      });
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildSystemPrompt(ctx) {
  const iLang = ctx.settings?.interactionLang || process.env.USER_INTERACTION_LANG || 'en';
  const oLang = ctx.settings?.outputLang      || process.env.USER_OUTPUT_LANG      || 'es';
  const name  = process.env.USER_NAME         || 'Hector';
  const tz    = process.env.USER_TIMEZONE     || 'America/Monterrey';
  const about = process.env.USER_CONTEXT      || '';

  const projectList = ctx.projects.map(p => {
    const conn    = ctx.connections.find(c => c.id === p.connId);
    const hasERP  = ctx.erpData?.[p.id] ? ' ✓ ERP live' : '';
    return `  - ${p.id}: ${p.name}${conn ? ` [${conn.label} · ${conn.typeId}${hasERP}]` : ' [no connection]'}`;
  }).join('\n');

  const { summary } = ctx;
  const urgentCount   = summary?.counts?.filter(r => r.priority === 'Urgent').reduce((a, r) => a + r.count, 0) || 0;
  const overdueCount  = summary?.overdue?.length || 0;
  const dueTodayCount = summary?.dueToday?.length || 0;

  const erpSection = formatERPSection(ctx.erpData || {});

  return `You are the personal AI assistant of ${name}. ${about}

## Language rules
- Interaction language: ${iLang === 'es' ? 'Spanish' : 'English'}. Always reply to ${name} in this language.
- Output/deliverable language: ${oLang === 'es' ? 'Spanish' : 'English'}. Use this when drafting documents or deliverables.

## Timezone
${tz}. Today is ${new Date().toLocaleDateString(iLang === 'es' ? 'es-MX' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })}.

## Projects
${projectList || '  (none configured)'}

## Task manager snapshot
- Urgent:   ${urgentCount}
- Overdue:  ${overdueCount}
- Due today: ${dueTodayCount}
- Total active: ${ctx.tasks.length}

## Active tasks (JSON)
${JSON.stringify(ctx.tasks, null, 2)}

${erpSection
  ? `## Live ERP data\n${erpSection}`
  : '## ERP data\nNo ERP data available — check connection configuration.'}

## Capabilities
- Read and manage tasks (create, update, delete)
- Answer questions about ERP documents (quotations, orders, invoices, issues, deliveries, payments)
- Give prioritized daily briefings combining tasks + ERP data
- Draft content in the correct output language

For task mutations append ONE action block:
<action>{"type":"create","task":{"title":"...","priority":"Urgent|Important|Can Wait","projectId":"<id>","status":"Inbox","description":"...","due":"YYYY-MM-DD or null","source":"chat","outputLang":"${oLang}"}}</action>
<action>{"type":"update","id":<number>,"changes":{...}}</action>
<action>{"type":"delete","id":<number>}</action>

Never fabricate task IDs. Only one action block per response.

## ERP writes (Phase 4 — not yet active)
If ${name} asks to create or update an ERP record, describe what you would do but do not execute it yet.

## Tone
Concise and direct. Most urgent first. 3-4 sentences max unless a full summary is requested.`;
}
