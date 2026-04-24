import { Router }    from 'express';
import Anthropic     from '@anthropic-ai/sdk';
import { buildContext, buildSystemPrompt } from '../lib/context.js';
import { executeAction }  from '../lib/actions.js';
import { runQuestion }    from '../tools/metabase.js';
import * as backend       from '../lib/backendClient.js';

const router = Router();
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

// ── Tool definitions sent to Claude ───────────────────────────────────────────
function buildTools(enabledModels) {
  const tools = [
    // Task mutations
    {
      name:        'manage_task',
      description: 'Create, update, or delete a task in the task manager.',
      input_schema: {
        type: 'object',
        properties: {
          action:  { type: 'string', enum: ['create', 'update', 'delete'], description: 'The operation to perform' },
          id:      { type: 'number', description: 'Task ID (required for update and delete)' },
          changes: {
            type: 'object',
            description: 'Fields to set (for create or update)',
            properties: {
              title:       { type: 'string' },
              description: { type: 'string' },
              priority:    { type: 'string', enum: ['Urgent', 'Important', 'Can Wait'] },
              projectId:   { type: 'string' },
              status:      { type: 'string', enum: ['Inbox', 'In Progress', 'Waiting', 'Done'] },
              due:         { type: 'string', description: 'YYYY-MM-DD or null' },
              outputLang:  { type: 'string', enum: ['en', 'es'] },
              source:      { type: 'string' },
            },
          },
        },
        required: ['action'],
      },
    },
  ];

  // Dynamically add one tool per enabled Metabase model
  if (enabledModels?.length) {
    tools.push({
      name:        'query_metabase',
      description: `Run a saved Metabase question to get live analytics data. Available questions:\n${
        enabledModels.map(m => `  - id:${m.questionId} "${m.label}"${m.description ? ' — ' + m.description : ''}`).join('\n')
      }`,
      input_schema: {
        type: 'object',
        properties: {
          question_id: {
            type:        'number',
            description: 'The numeric ID of the Metabase question to run. Must be one of the available IDs listed above.',
          },
          reason: {
            type:        'string',
            description: 'Brief explanation of why this question answers the user\'s request.',
          },
        },
        required: ['question_id'],
      },
    });
  }

  return tools;
}

// ── Tool execution ─────────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, enabledModels, iLang) {
  if (toolName === 'manage_task') {
    const { action, id, changes } = toolInput;
    try {
      let result;
      if (action === 'create') result = await backend.createTask({ ...changes, source: changes.source || 'chat' });
      if (action === 'update') result = await backend.updateTask(id, changes);
      if (action === 'delete') result = await backend.deleteTask(id);
      const confirm = iLang === 'es' ? '✓ Listo.' : '✓ Done.';
      return { success: true, result, confirm };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (toolName === 'query_metabase') {
    const { question_id } = toolInput;
    const model = enabledModels.find(m => m.questionId === question_id);
    if (!model) return { success: false, error: `Question ${question_id} is not in the enabled model registry.` };

    try {
      const result = await runQuestion(model.connId, question_id);
      if (result.stub) return { success: false, error: 'Connection not configured.' };

      // Format as markdown table for Claude to read
      const { cols, rows, summary } = result;
      if (!rows?.length) return { success: true, data: `${model.label}: No data returned.` };

      const header = cols.join(' | ');
      const sep    = cols.map(() => '---').join(' | ');
      const body   = rows.slice(0, 30).map(row => cols.map(c => String(row[c] ?? '')).join(' | ')).join('\n');
      const more   = rows.length > 30 ? `\n_...and ${rows.length - 30} more rows_` : '';

      return { success: true, data: `**${model.label}** (${summary})\n\n${header}\n${sep}\n${body}${more}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: `Unknown tool: ${toolName}` };
}

// ── POST /orchestrate/chat ─────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { message, history = [], channel = 'chat' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  try {
    const [ctx, enabledModels] = await Promise.all([
      buildContext(),
      backend.getEnabledMetabaseModels(),
    ]);

    const system   = buildSystemPrompt(ctx, enabledModels);
    const iLang    = ctx.settings?.interactionLang || 'en';
    const tools    = buildTools(enabledModels);

    // Build message history
    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message.trim() },
    ];

    let finalReply   = '';
    let actionResult = null;

    // ── Agentic loop — Claude may call tools multiple times ────────────────────
    let loopMessages = [...messages];
    for (let i = 0; i < 5; i++) { // max 5 tool call rounds
      const response = await claude.messages.create({
        model:      MODEL,
        max_tokens: 1024,
        system,
        tools,
        messages:   loopMessages,
      });

      // If Claude stopped naturally — we have our answer
      if (response.stop_reason === 'end_turn') {
        finalReply = response.content.find(b => b.type === 'text')?.text || '';
        break;
      }

      // Claude wants to use a tool
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const textBlock     = response.content.find(b => b.type === 'text');

        // Add Claude's response (including tool_use blocks) to history
        loopMessages.push({ role: 'assistant', content: response.content });

        // Execute all requested tools and collect results
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block) => {
            const result = await executeTool(block.name, block.input, enabledModels, iLang);
            if (block.name === 'manage_task' && result.success) actionResult = result.result;
            return {
              type:        'tool_result',
              tool_use_id: block.id,
              content:     result.success
                ? (result.data || result.confirm || JSON.stringify(result.result))
                : `Error: ${result.error}`,
            };
          })
        );

        // Add tool results to history for next round
        loopMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason — break
      finalReply = response.content.find(b => b.type === 'text')?.text || '';
      break;
    }

    res.json({
      reply:        finalReply,
      actionResult: actionResult || null,
      context: {
        urgentCount:  ctx.summary?.counts?.filter(r => r.priority === 'Urgent').reduce((a, r) => a + r.count, 0) || 0,
        overdueCount: ctx.summary?.overdue?.length || 0,
        totalActive:  ctx.tasks.length,
      },
    });

  } catch (err) {
    console.error('[orchestrate/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /orchestrate/briefing ─────────────────────────────────────────────────
router.post('/briefing', async (req, res) => {
  try {
    const [ctx, enabledModels] = await Promise.all([
      buildContext(),
      backend.getEnabledMetabaseModels(),
    ]);
    const iLang  = req.body?.lang || ctx.settings?.interactionLang || 'en';
    const system = buildSystemPrompt(ctx, enabledModels);
    const tools  = buildTools(enabledModels);

    const prompt = iLang === 'es'
      ? 'Dame un resumen ejecutivo de mi día. Usa las herramientas disponibles para obtener datos actualizados si lo necesitas. Prioriza lo urgente, señala lo vencido, y dime qué puede esperar.'
      : 'Give me an executive briefing of my day. Use available tools to fetch current data if needed. Prioritize urgent items, flag overdue, tell me what can wait.';

    // Allow briefing to use tools too
    const messages = [{ role: 'user', content: prompt }];
    let finalReply = '';
    let loopMessages = [...messages];

    for (let i = 0; i < 5; i++) {
      const response = await claude.messages.create({
        model: MODEL, max_tokens: 1024, system, tools, messages: loopMessages,
      });

      if (response.stop_reason === 'end_turn') {
        finalReply = response.content.find(b => b.type === 'text')?.text || '';
        break;
      }

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        loopMessages.push({ role: 'assistant', content: response.content });
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block) => {
            const result = await executeTool(block.name, block.input, enabledModels, iLang);
            return { type: 'tool_result', tool_use_id: block.id, content: result.success ? (result.data || JSON.stringify(result.result)) : `Error: ${result.error}` };
          })
        );
        loopMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      finalReply = response.content.find(b => b.type === 'text')?.text || '';
      break;
    }

    res.json({ briefing: finalReply, context: { urgentCount: ctx.summary?.counts?.filter(r=>r.priority==='Urgent').reduce((a,r)=>a+r.count,0)||0, overdueCount: ctx.summary?.overdue?.length||0, totalActive: ctx.tasks.length } });

  } catch (err) {
    console.error('[orchestrate/briefing]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /orchestrate/ingest ───────────────────────────────────────────────────
router.post('/ingest', async (req, res) => {
  const { text, source = 'forwarded' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

  try {
    const ctx   = await buildContext();
    const iLang = ctx.settings?.interactionLang || 'en';
    const oLang = ctx.settings?.outputLang      || 'es';
    const system= buildSystemPrompt(ctx, []);
    const projectIds = ctx.projects.map(p => p.id).join(', ');

    const prompt = `The following message was forwarded from ${source}. Extract actionable tasks. Return ONLY a JSON array, no other text:
[{"title":"...","priority":"Urgent|Important|Can Wait","projectId":"...","description":"...","due":"YYYY-MM-DD or null","outputLang":"${oLang}"}]

Available project IDs: ${projectIds}

Message:
${text.trim()}`;

    const response = await claude.messages.create({
      model: MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content?.[0]?.text || '[]';
    let tasks = [];
    try { tasks = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { tasks = []; }
    res.json({ tasks, source });

  } catch (err) {
    console.error('[orchestrate/ingest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
