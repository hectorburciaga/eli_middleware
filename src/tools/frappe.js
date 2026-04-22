import fetch from 'node-fetch';
import * as backend from '../lib/backendClient.js';

/**
 * Frappe/ERPNext connector.
 * Credentials are loaded from the connection registry (not hardcoded).
 * Doctypes to fetch are driven by a configurable registry below —
 * add custom doctypes without touching any other file.
 */

// ── Doctype registry ──────────────────────────────────────────────────────────
// Each entry defines how to fetch and display a Frappe doctype.
// To add a custom doctype: append an entry to this array.
// Fields must exist on the doctype — check your Frappe instance if unsure.
//
// Standard filter values reference:
//   docstatus: 0=Draft, 1=Submitted, 2=Cancelled
//   status: varies per doctype

export const DOCTYPE_REGISTRY = [
  {
    id:       'quotations',
    label:    'Quotations',
    doctype:  'Quotation',
    filters:  [['docstatus', '=', 1], ['status', 'not in', ['Ordered', 'Cancelled', 'Lost']]],
    fields:   ['name', 'party_name', 'transaction_date', 'valid_till', 'grand_total', 'currency', 'status'],
    display:  (r) => `${r.party_name} · ${r.grand_total} ${r.currency} · ${r.status}${r.valid_till ? ' · valid till ' + r.valid_till : ''}`,
  },
  {
    id:       'sales_orders',
    label:    'Sales Orders',
    doctype:  'Sales Order',
    filters:  [['docstatus', '=', 1], ['status', 'not in', ['Completed', 'Cancelled', 'Closed']]],
    fields:   ['name', 'customer', 'transaction_date', 'delivery_date', 'grand_total', 'currency', 'status', 'per_delivered', 'per_billed'],
    display:  (r) => `${r.customer} · ${r.grand_total} ${r.currency} · ${r.status} · delivered ${r.per_delivered || 0}% · billed ${r.per_billed || 0}%`,
  },
  {
    id:       'purchase_orders',
    label:    'Purchase Orders',
    doctype:  'Purchase Order',
    filters:  [['docstatus', '=', 1], ['status', 'not in', ['Completed', 'Cancelled', 'Closed']]],
    fields:   ['name', 'supplier', 'transaction_date', 'schedule_date', 'grand_total', 'currency', 'status', 'per_received', 'per_billed'],
    display:  (r) => `${r.supplier} · ${r.grand_total} ${r.currency} · ${r.status}${r.schedule_date ? ' · due ' + r.schedule_date : ''}`,
  },
  {
    id:       'sales_invoices',
    label:    'Unpaid Sales Invoices',
    doctype:  'Sales Invoice',
    filters:  [['docstatus', '=', 1], ['outstanding_amount', '>', 0]],
    fields:   ['name', 'customer', 'posting_date', 'due_date', 'grand_total', 'outstanding_amount', 'currency'],
    display:  (r) => `${r.customer} · outstanding ${r.outstanding_amount} ${r.currency}${r.due_date ? ' · due ' + r.due_date : ''}`,
  },
  {
    id:       'issues',
    label:    'Open Issues',
    doctype:  'Issue',
    filters:  [['status', 'not in', ['Resolved', 'Closed']]],
    fields:   ['name', 'subject', 'customer', 'status', 'priority', 'opening_date'],
    display:  (r) => `[${r.priority || 'Medium'}] ${r.subject}${r.customer ? ' · ' + r.customer : ''}`,
  },
  {
    id:       'delivery_notes',
    label:    'Open Delivery Notes',
    doctype:  'Delivery Note',
    filters:  [['docstatus', '=', 1], ['status', 'not in', ['Completed', 'Cancelled', 'Closed']]],
    fields:   ['name', 'customer', 'posting_date', 'grand_total', 'currency', 'status', 'per_installed'],
    display:  (r) => `${r.customer} · ${r.grand_total} ${r.currency} · ${r.status}`,
  },
  {
    id:       'payment_entries',
    label:    'Recent Payment Entries',
    doctype:  'Payment Entry',
    filters:  [['docstatus', '=', 1], ['posting_date', '>=', relativeDate(-30)]],
    fields:   ['name', 'party', 'party_type', 'payment_type', 'paid_amount', 'paid_to_account_currency', 'posting_date', 'remarks'],
    display:  (r) => `${r.payment_type} · ${r.party} · ${r.paid_amount} ${r.paid_to_account_currency} · ${r.posting_date}`,
  },

  // ── Custom doctypes ────────────────────────────────────────────────────────
  // Add your custom Frappe doctypes here. Example:
  //
  // {
  //   id:      'my_custom_doc',
  //   label:   'My Custom Documents',
  //   doctype: 'My Custom Doctype',          // exact Frappe doctype name
  //   filters: [['status', '!=', 'Closed']], // Frappe filter syntax
  //   fields:  ['name', 'title', 'status'],  // fields to fetch
  //   display: (r) => `${r.title} · ${r.status}`,  // how to format in briefings
  // },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function relativeDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function getConnectionConfig(connectionId) {
  try {
    const conn = await backend.getConnection(connectionId);
    if (!conn || conn.status !== 'configured') return null;
    return conn.config;
  } catch {
    return null;
  }
}

async function frappeFetch(baseUrl, apiKey, apiSecret, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `token ${apiKey}:${apiSecret}`,
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

async function fetchDoctype(config, entry, limit = 20) {
  const qs = new URLSearchParams({
    fields:  JSON.stringify(entry.fields),
    filters: JSON.stringify(entry.filters),
    limit,
    order_by: 'modified desc',
  });
  try {
    const data = await frappeFetch(
      config.url, config.api_key, config.secret,
      `/api/resource/${encodeURIComponent(entry.doctype)}?${qs}`
    );
    return data.data || [];
  } catch (err) {
    // Doctype may not exist on this instance — return empty rather than crash
    console.warn(`[frappe] ${entry.doctype} fetch failed: ${err.message}`);
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a full ERP snapshot for a connection.
 * All registered doctypes are fetched in parallel.
 * Custom doctypes added to DOCTYPE_REGISTRY are automatically included.
 */
export async function getERPSnapshot(connectionId) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const results = await Promise.all(
    DOCTYPE_REGISTRY.map(async (entry) => ({
      id:    entry.id,
      label: entry.label,
      data:  await fetchDoctype(config, entry),
    }))
  );

  // Build result object keyed by doctype id
  const snapshot = { stub: false };
  for (const r of results) snapshot[r.id] = r;
  return snapshot;
}

/**
 * Fetch a single doctype by its registry id.
 * e.g. fetchOne(connId, 'quotations')
 */
export async function fetchOne(connectionId, doctypeId) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true, message: `Connection '${connectionId}' not configured.` };

  const entry = DOCTYPE_REGISTRY.find(e => e.id === doctypeId);
  if (!entry) return { stub: true, message: `Doctype '${doctypeId}' not in registry.` };

  const data = await fetchDoctype(config, entry);
  return { stub: false, label: entry.label, data };
}

/**
 * Create a record in Frappe.
 * Only called after write authorization is confirmed (Phase 4).
 */
export async function createRecord(connectionId, doctype, data) {
  const config = await getConnectionConfig(connectionId);
  if (!config) throw new Error(`Connection '${connectionId}' not configured.`);

  return frappeFetch(config.url, config.api_key, config.secret,
    `/api/resource/${encodeURIComponent(doctype)}`,
    { method: 'POST', body: data }
  );
}

/**
 * Update a record in Frappe.
 * Only called after write authorization is confirmed (Phase 4).
 */
export async function updateRecord(connectionId, doctype, name, data) {
  const config = await getConnectionConfig(connectionId);
  if (!config) throw new Error(`Connection '${connectionId}' not configured.`);

  return frappeFetch(config.url, config.api_key, config.secret,
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    { method: 'PUT', body: data }
  );
}
