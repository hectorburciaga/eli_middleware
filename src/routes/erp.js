import { Router } from 'express';
import {
  getOpenProjects,
  getProjectTasks,
  getOpenQuotations,
  getUnpaidInvoices,
  getOpenIssues,
  getERPSnapshot,
} from '../tools/frappe.js';
import * as backend from '../lib/backendClient.js';

const router = Router();

/**
 * GET /erp/snapshot/:projectId
 *
 * Returns the full ERP snapshot for a given project's connection.
 * Used by the frontend to show live ERP data alongside tasks.
 */
router.get('/snapshot/:projectId', async (req, res) => {
  try {
    const projects = await backend.getProjects();
    const project  = projects.find(p => p.id === req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.connId) return res.json({ stub: true, message: 'Project has no connection configured.' });

    const snapshot = await getERPSnapshot(project.connId);
    res.json({ project: project.name, ...snapshot });
  } catch (err) {
    console.error('[erp/snapshot]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /erp/projects/:projectId
 * Returns open ERP projects for a given task manager project's connection.
 */
router.get('/projects/:projectId', async (req, res) => {
  try {
    const projects = await backend.getProjects();
    const project  = projects.find(p => p.id === req.params.projectId);
    if (!project?.connId) return res.json({ stub: true, message: 'No connection configured.' });
    res.json(await getOpenProjects(project.connId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /erp/tasks/:projectId
 * Returns open ERP tasks for a given task manager project's connection.
 */
router.get('/tasks/:projectId', async (req, res) => {
  try {
    const projects   = await backend.getProjects();
    const project    = projects.find(p => p.id === req.params.projectId);
    if (!project?.connId) return res.json({ stub: true, message: 'No connection configured.' });
    const erpProject = req.query.erp_project || null;
    res.json(await getProjectTasks(project.connId, erpProject));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /erp/quotations/:projectId
 */
router.get('/quotations/:projectId', async (req, res) => {
  try {
    const projects = await backend.getProjects();
    const project  = projects.find(p => p.id === req.params.projectId);
    if (!project?.connId) return res.json({ stub: true, message: 'No connection configured.' });
    res.json(await getOpenQuotations(project.connId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /erp/invoices/:projectId
 */
router.get('/invoices/:projectId', async (req, res) => {
  try {
    const projects = await backend.getProjects();
    const project  = projects.find(p => p.id === req.params.projectId);
    if (!project?.connId) return res.json({ stub: true, message: 'No connection configured.' });
    res.json(await getUnpaidInvoices(project.connId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /erp/issues/:projectId
 */
router.get('/issues/:projectId', async (req, res) => {
  try {
    const projects = await backend.getProjects();
    const project  = projects.find(p => p.id === req.params.projectId);
    if (!project?.connId) return res.json({ stub: true, message: 'No connection configured.' });
    res.json(await getOpenIssues(project.connId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
