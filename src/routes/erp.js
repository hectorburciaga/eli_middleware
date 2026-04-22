import { Router } from 'express';
import { getERPSnapshot, fetchOne, DOCTYPE_REGISTRY } from '../tools/frappe.js';
import * as backend from '../lib/backendClient.js';

const router = Router();

// Helper — resolves a task manager project to its connection ID
async function resolveConnection(projectId) {
  const projects = await backend.getProjects();
  const project  = projects.find(p => p.id === projectId);
  if (!project)       throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.connId) throw Object.assign(new Error('Project has no connection configured'), { status: 400 });
  return { project, connId: project.connId };
}

/**
 * GET /erp/registry
 * Returns the list of registered doctypes — useful for the frontend
 * to know what it can query, including any custom ones.
 */
router.get('/registry', (req, res) => {
  res.json(DOCTYPE_REGISTRY.map(e => ({ id: e.id, label: e.label, doctype: e.doctype })));
});

/**
 * GET /erp/snapshot/:projectId
 * Full snapshot across all registered doctypes for a project's connection.
 */
router.get('/snapshot/:projectId', async (req, res) => {
  try {
    const { project, connId } = await resolveConnection(req.params.projectId);
    const snapshot = await getERPSnapshot(connId);
    res.json({ project: project.name, ...snapshot });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /erp/:projectId/:doctypeId
 * Fetch a single doctype by its registry id for a project.
 * e.g. GET /erp/proj_123/quotations
 *      GET /erp/proj_123/sales_orders
 *      GET /erp/proj_123/my_custom_doc  ← works automatically once added to registry
 */
router.get('/:projectId/:doctypeId', async (req, res) => {
  try {
    const { connId } = await resolveConnection(req.params.projectId);
    const result     = await fetchOne(connId, req.params.doctypeId);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
