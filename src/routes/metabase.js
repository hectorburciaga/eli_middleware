import { Router } from 'express';
import {
  listQuestions,
  runQuestion,
  runQuestionWithParams,
  getQuestionInfo,
  searchQuestions,
} from '../tools/metabase.js';
import * as backend from '../lib/backendClient.js';

const router = Router();

async function resolveMetabaseConn(projectId) {
  const projects    = await backend.getProjects();
  const connections = await backend.getConnections();
  const project     = projects.find(p => p.id === projectId);
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  // Look for a metabase connection on this project, or a global one
  const conn = connections.find(c => c.typeId === 'metabase' && c.status === 'configured');
  if (!conn) throw Object.assign(new Error('No configured Metabase connection found. Add one in Settings → Connections.'), { status: 400 });

  return { project, connId: conn.id };
}

/**
 * GET /metabase/questions
 * List all available saved questions.
 * Query: ?collection=IAARQ  (optional filter by collection name)
 */
router.get('/questions', async (req, res) => {
  try {
    const connections = await backend.getConnections();
    const conn        = connections.find(c => c.typeId === 'metabase' && c.status === 'configured');
    if (!conn) return res.status(400).json({ error: 'No Metabase connection configured.' });
    res.json(await listQuestions(conn.id, req.query.collection || null));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * GET /metabase/questions/search
 * Search saved questions by name.
 * Query: ?q=sales+monthly
 */
router.get('/questions/search', async (req, res) => {
  try {
    const connections = await backend.getConnections();
    const conn        = connections.find(c => c.typeId === 'metabase' && c.status === 'configured');
    if (!conn) return res.status(400).json({ error: 'No Metabase connection configured.' });
    res.json(await searchQuestions(conn.id, req.query.q || ''));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * GET /metabase/questions/:id
 * Get metadata about a specific question.
 */
router.get('/questions/:id', async (req, res) => {
  try {
    const connections = await backend.getConnections();
    const conn        = connections.find(c => c.typeId === 'metabase' && c.status === 'configured');
    if (!conn) return res.status(400).json({ error: 'No Metabase connection configured.' });
    res.json(await getQuestionInfo(conn.id, req.params.id));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * POST /metabase/questions/:id/run
 * Run a saved question and return formatted results.
 * Body: { parameters: [] }  (optional — for date-filtered questions)
 */
router.post('/questions/:id/run', async (req, res) => {
  try {
    const connections = await backend.getConnections();
    const conn        = connections.find(c => c.typeId === 'metabase' && c.status === 'configured');
    if (!conn) return res.status(400).json({ error: 'No Metabase connection configured.' });

    const { parameters } = req.body || {};
    const result = parameters?.length
      ? await runQuestionWithParams(conn.id, req.params.id, parameters)
      : await runQuestion(conn.id, req.params.id);

    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

export default router;
