import * as backend from './backendClient.js';

/**
 * Builds the full context object Claude needs to answer questions
 * and take actions. Called at the start of every orchestration turn.
 */
export async function buildContext() {
  const [tasks, projects, connections, settings, summary] = await Promise.all([
    backend.getTasks({ include_done: 0 }),
    backend.getProjects(),
    backend.getConnections(),
    backend.getSettings(),
    backend.getTaskSummary(),
  ]);

  return { tasks, projects, connections, settings, summary };
}

/**
 * Builds the system prompt for Claude using live context.
 * Language, user details, and tool instructions are all injected here.
 */
export function buildSystemPrompt(ctx) {
  const iLang = ctx.settings?.interactionLang || process.env.USER_INTERACTION_LANG || 'en';
  const oLang = ctx.settings?.outputLang      || process.env.USER_OUTPUT_LANG      || 'es';
  const name  = process.env.USER_NAME         || 'Hector';
  const tz    = process.env.USER_TIMEZONE     || 'America/Monterrey';
  const about = process.env.USER_CONTEXT      || '';

  const projectList = ctx.projects.map(p => {
    const conn = ctx.connections.find(c => c.id === p.connId);
    return `  - ${p.id}: ${p.name}${conn ? ` [${conn.label} · ${conn.typeId}]` : ' [no connection]'}`;
  }).join('\n');

  const { summary } = ctx;
  const urgentCount  = summary?.counts?.filter(r => r.priority === 'Urgent').reduce((a, r) => a + r.count, 0) || 0;
  const overdueCount = summary?.overdue?.length || 0;
  const dueTodayCount= summary?.dueToday?.length || 0;

  return `You are the personal AI assistant of ${name}. ${about}

## Language rules
- Interaction language: ${iLang === 'es' ? 'Spanish' : 'English'}. Always reply to ${name} in this language regardless of what language they write in.
- Output/deliverable language: ${oLang === 'es' ? 'Spanish' : 'English'}. Use this when drafting documents, emails, or any deliverable content unless the task specifies otherwise.

## User timezone
${tz}. Today is ${new Date().toLocaleDateString(iLang === 'es' ? 'es-MX' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })}.

## Projects
${projectList || '  (none configured)'}

## Current task snapshot
- Urgent tasks:   ${urgentCount}
- Overdue tasks:  ${overdueCount}
- Due today:      ${dueTodayCount}
- Total active:   ${ctx.tasks.length}

## Active tasks (JSON)
${JSON.stringify(ctx.tasks, null, 2)}

## Your capabilities
You can read and manage tasks, give prioritized daily briefings, help plan ${name}'s day, draft content in the correct output language, and answer questions about projects and workload.

When ${name} asks you to create, update, or delete a task, respond conversationally AND append a single structured action block at the end of your reply using this exact format:

<action>{"type":"create","task":{"title":"...","priority":"Urgent|Important|Can Wait","projectId":"<id from projects list>","status":"Inbox","description":"...","due":"YYYY-MM-DD or null","source":"chat","outputLang":"${oLang}"}}</action>

<action>{"type":"update","id":<number>,"changes":{"status":"...","priority":"..."}}</action>

<action>{"type":"delete","id":<number>}</action>

Only one action block per response. Never fabricate task IDs — only reference IDs that exist in the active tasks JSON above.

## ERP connections
The following ERP/file connections are registered but managed through the connection registry. When ${name} asks about ERP data, acknowledge that direct ERP reads will be available once the ERP connector phase is complete, and offer to create a task to follow up instead.

## Tone
Be concise and direct. ${name} is a busy professional. Give prioritized answers — most urgent first. Max 3-4 sentences unless a full summary or draft is explicitly requested.`;
}
