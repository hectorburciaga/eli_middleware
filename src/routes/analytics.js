import { Router } from 'express';
import {
  quotationPipeline,
  monthlySales,
  monthlyPurchases,
  monthlyTotals,
  invoiceReport,
} from '../tools/frappeAnalytics.js';
import * as backend from '../lib/backendClient.js';

const router = Router();

async function resolveConnection(projectId) {
  const projects = await backend.getProjects();
  const project  = projects.find(p => p.id === projectId);
  if (!project)        throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.connId) throw Object.assign(new Error('No connection configured'), { status: 400 });
  return { project, connId: project.connId };
}

/**
 * GET /analytics/:projectId/pipeline
 * Quotation pipeline — all non-cancelled quotes with age and value breakdown.
 * Query: ?months=6
 */
router.get('/:projectId/pipeline', async (req, res) => {
  try {
    const { connId } = await resolveConnection(req.params.projectId);
    const months     = parseInt(req.query.months) || 6;
    res.json(await quotationPipeline(connId, months));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * GET /analytics/:projectId/sales
 * Monthly sales totals from Sales Orders.
 * Query: ?months=12
 */
router.get('/:projectId/sales', async (req, res) => {
  try {
    const { connId } = await resolveConnection(req.params.projectId);
    const months     = parseInt(req.query.months) || 12;
    res.json(await monthlySales(connId, months));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * GET /analytics/:projectId/purchases
 * Monthly purchase totals from Purchase Orders.
 * Query: ?months=12
 */
router.get('/:projectId/purchases', async (req, res) => {
  try {
    const { connId } = await resolveConnection(req.params.projectId);
    const months     = parseInt(req.query.months) || 12;
    res.json(await monthlyPurchases(connId, months));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * GET /analytics/:projectId/invoices
 * Invoice collection report — outstanding and overdue breakdown.
 */
router.get('/:projectId/invoices', async (req, res) => {
  try {
    const { connId } = await resolveConnection(req.params.projectId);
    res.json(await invoiceReport(connId));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * GET /analytics/:projectId/custom
 * Generic monthly totals for any doctype — supports custom doctypes.
 * Query: ?doctype=My Custom Doc&dateField=creation&amountField=grand_total&currencyField=currency&months=12
 */
router.get('/:projectId/custom', async (req, res) => {
  try {
    const { connId }  = await resolveConnection(req.params.projectId);
    const { doctype, dateField, amountField, currencyField, months } = req.query;
    if (!doctype || !dateField || !amountField) {
      return res.status(400).json({ error: 'doctype, dateField, and amountField are required' });
    }
    res.json(await monthlyTotals(connId, doctype, dateField, amountField, currencyField || 'currency', [], parseInt(months) || 12));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

export default router;
