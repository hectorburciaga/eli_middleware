import fetch from 'node-fetch';
import * as backend from '../lib/backendClient.js';

/**
 * Frappe/ERPNext connector.
 * Credentials are loaded from the connection registry (not hardcoded).
 * When a connection has status = 'configured', real API calls are made.
 * When unconfigured, a clear stub response is returned instead of failing.
 */

// ── Load connection config from the registry ──────────────────────────────────
async function getConnectionConfig(connectionId) {
  try {
    const conn = await backend.getConnection(connectionId);
    if (!conn || conn.status !== 'configured') return null;
    return conn.config; // decrypted by backend
  } catch {
    return null;
  }
}

// ── Base Frappe API call ───────────────────────────────────────────────────────
async function frappeFetch(baseUrl, apiKey, apiSecret, path, options = {}) {
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Basic ${credentials}`,
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `Frappe error ${res.status}`);
  }

  return res.json();
}

// ── Generic resource fetcher ───────────────────────────────────────────────────
async function getResource(config, doctype, filters = [], fields = ['name', 'subject', 'status']) {
  const qs = new URLSearchParams({
    doctype,
    fields:  JSON.stringify(fields),
    filters: JSON.stringify(filters),
    limit:   50,
  });
  return frappeFetch(config.url, config.api_key, config.secret, `/api/resource/${doctype}?${qs}`);
}

// ── Public connector methods ───────────────────────────────────────────────────

/**
 * Get open projects from a Frappe instance.
 * connectionId comes from the project's connId in the registry.
 */
export async function getOpenProjects(connectionId) {
  const config = await getConnectionConfig(connectionId);
  if (!config) {
    return { stub: true, message: `ERP connection '${connectionId}' is not configured yet. Add credentials in Settings → Connections.` };
  }

  const data = await getResource(config, 'Project',
    [['status', '=', 'Open']],
    ['name', 'project_name', 'status', 'percent_complete', 'expected_end_date']
  );
  return { stub: false, data: data.data || [] };
}

/**
 * Get open tasks from a Frappe instance for a given project.
 */
export async function getProjectTasks(connectionId, projectName) {
  const config = await getConnectionConfig(connectionId);
  if (!config) {
    return { stub: true, message: `ERP connection '${connectionId}' is not configured yet.` };
  }

  const filters = [['project', '=', projectName], ['status', '!=', 'Cancelled']];
  const data    = await getResource(config, 'Task', filters,
    ['name', 'subject', 'status', 'priority', 'exp_end_date', 'description']
  );
  return { stub: false, data: data.data || [] };
}

/**
 * Get open sales orders / quotations from a Frappe instance.
 */
export async function getOpenQuotations(connectionId) {
  const config = await getConnectionConfig(connectionId);
  if (!config) {
    return { stub: true, message: `ERP connection '${connectionId}' is not configured yet.` };
  }

  const data = await getResource(config, 'Quotation',
    [['docstatus', '=', 1], ['status', 'not in', ['Ordered', 'Cancelled']]],
    ['name', 'party_name', 'grand_total', 'currency', 'transaction_date', 'valid_till']
  );
  return { stub: false, data: data.data || [] };
}

/**
 * Create a task in Frappe.
 * Only called when write authorization has been confirmed.
 */
export async function createFrappeTask(connectionId, taskData) {
  const config = await getConnectionConfig(connectionId);
  if (!config) throw new Error(`ERP connection '${connectionId}' is not configured.`);

  return frappeFetch(config.url, config.api_key, config.secret, '/api/resource/Task', {
    method: 'POST',
    body:   taskData,
  });
}
