import { Router }       from 'express';
import Anthropic        from '@anthropic-ai/sdk';
import { buildContext, buildSystemPrompt } from '../lib/context.js';
import { executeAction } from '../lib/actions.js';

const router  = Router();
const claude  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL   = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

/**
 * POST /orchestrate/chat
 *
 * Main chat endpoint. Accepts a message + conversation history,
 * builds full context from the backend, calls Claude, executes
 * any resulting actions, and returns the response.
 *
 * Body:
 * {
 *   message:  string,           // current user message
 *   history:  [{role, content}] // previous turns (optional)
 *   channel:  string            // 'chat' | 'whatsapp' | 'email' (optional)
 * }
 *
 * Response:
 * {
 *   reply:        string,  // clean response text
 *   actionResult: object,  // result of any task mutation (or null)
 *   context:      object   // summary counts (for UI refresh hints)
 * }
 */
router.post('/chat', async (req, res) => {
  const { message, history = [], channel = 'chat' } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    // 1. Build fresh context from backend
    const ctx    = await buildContext();
    const system = buildSystemPrompt(ctx);
    const iLang  = ctx.settings?.interactionLang || 'en';

    // 2. Assemble message history + new message
    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message.trim() },
    ];

    // 3. Call Claude
    const response = await claude.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system,
      messages,
    });

    const raw = response.content?.[0]?.text || '';

    // 4. Execute any action Claude decided on
    const { display, actionResult } = await executeAction(raw, iLang);

    // 5. Return
    res.json({
      reply:        display,
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

/**
 * POST /orchestrate/briefing
 *
 * Generates a daily briefing using Claude — richer than the
 * template-based digest in the backend, because Claude prioritizes
 * and adds context.
 *
 * Body: { lang: 'en' | 'es' }  (optional, falls back to settings)
 */
router.post('/briefing', async (req, res) => {
  try {
    const ctx    = await buildContext();
    const iLang  = req.body?.lang || ctx.settings?.interactionLang || 'en';
    const system = buildSystemPrompt(ctx);

    const prompt = iLang === 'es'
      ? 'Dame un resumen ejecutivo de mi día. Prioriza lo urgente, señala lo vencido, y dime qué puedo dejar para después. Sé conciso y directo.'
      : 'Give me an executive briefing of my day. Prioritize urgent items, flag anything overdue, and tell me what can wait. Be concise and direct.';

    const response = await claude.messages.create({
      model:      MODEL,
      max_tokens: 800,
      system,
      messages:   [{ role: 'user', content: prompt }],
    });

    res.json({
      briefing: response.content?.[0]?.text || '',
      context: {
        urgentCount:  ctx.summary?.counts?.filter(r => r.priority === 'Urgent').reduce((a, r) => a + r.count, 0) || 0,
        overdueCount: ctx.summary?.overdue?.length || 0,
        totalActive:  ctx.tasks.length,
      },
    });

  } catch (err) {
    console.error('[orchestrate/briefing]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /orchestrate/ingest
 *
 * Accepts a raw forwarded message (from email or WhatsApp) and
 * asks Claude to extract tasks from it. Returns structured task
 * candidates for the user to confirm before creating.
 *
 * Body: { text: string, source: 'email' | 'whatsapp' }
 */
router.post('/ingest', async (req, res) => {
  const { text, source = 'forwarded' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

  try {
    const ctx    = await buildContext();
    const iLang  = ctx.settings?.interactionLang || 'en';
    const oLang  = ctx.settings?.outputLang      || 'es';
    const system = buildSystemPrompt(ctx);

    const projectIds = ctx.projects.map(p => p.id).join(', ');

    const prompt = `The following message was forwarded to you from ${source}. Extract any actionable tasks from it. For each task, suggest a title, priority, project (from: ${projectIds}), and due date if mentioned. Return ONLY a JSON array, no other text:

[{"title":"...","priority":"Urgent|Important|Can Wait","projectId":"...","description":"...","due":"YYYY-MM-DD or null","outputLang":"${oLang}"}]

Message:
${text.trim()}`;

    const response = await claude.messages.create({
      model:      MODEL,
      max_tokens: 600,
      system,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw = response.content?.[0]?.text || '[]';
    let tasks = [];
    try {
      tasks = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      tasks = [];
    }

    res.json({ tasks, source });

  } catch (err) {
    console.error('[orchestrate/ingest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
