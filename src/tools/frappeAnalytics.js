import fetch from 'node-fetch';
import * as backend from '../lib/backendClient.js';

/**
 * Frappe analytics layer.
 * Handles aggregation and reporting queries — separate from the
 * operational snapshot so the main context stays lean.
 *
 * All methods return pre-aggregated data ready for Claude to summarize,
 * rather than raw record lists. This keeps token usage low even when
 * querying large datasets.
 */

// ── Auth helper (shared with frappe.js via backendClient) ─────────────────────
async function getConnectionConfig(connectionId) {
  try {
    const conn = await backend.getConnection(connectionId);
    if (!conn || conn.status !== 'configured') return null;
    return conn.config;
  } catch { return null; }
}

async function frappeFetch(baseUrl, apiKey, apiSecret, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `token ${apiKey}:${apiSecret}`,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `Frappe error ${res.status}`);
  }
  return res.json();
}

// Fetch raw records with flexible filters and fields
async function fetchRaw(config, doctype, filters, fields, limit = 500) {
  const qs = new URLSearchParams({
    fields:   JSON.stringify(fields),
    filters:  JSON.stringify(filters),
    limit,
    order_by: 'creation desc',
  });
  const data = await frappeFetch(
    config.url, config.api_key, config.secret,
    `/api/resource/${encodeURIComponent(doctype)}?${qs}`
  );
  return data.data || [];
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
}
function endOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0];
}
function monthsBack(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}
function monthLabel(dateStr) {
  const d = new Date(dateStr + '-01');
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
function toYearMonth(dateStr) {
  return dateStr?.slice(0, 7); // 'YYYY-MM'
}

// ── Aggregation helpers ───────────────────────────────────────────────────────
function groupByMonth(records, dateField, amountField, currencyField) {
  const groups = {};
  for (const r of records) {
    const ym  = toYearMonth(r[dateField]);
    if (!ym) continue;
    const cur = r[currencyField] || 'MXN';
    const key = `${ym}|${cur}`;
    if (!groups[key]) groups[key] = { month: ym, currency: cur, total: 0, count: 0 };
    groups[key].total += parseFloat(r[amountField] || 0);
    groups[key].count += 1;
  }
  return Object.values(groups).sort((a, b) => a.month.localeCompare(b.month));
}

function groupByStatus(records, statusField, amountField, currencyField) {
  const groups = {};
  for (const r of records) {
    const status = r[statusField] || 'Unknown';
    const cur    = r[currencyField] || 'MXN';
    const key    = `${status}|${cur}`;
    if (!groups[key]) groups[key] = { status, currency: cur, total: 0, count: 0 };
    groups[key].total += parseFloat(r[amountField] || 0);
    groups[key].count += 1;
  }
  return Object.values(groups).sort((a, b) => b.total - a.total);
}

function ageDays(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// ── Public analytics methods ──────────────────────────────────────────────────

/**
 * Quotation pipeline report.
 * Returns all non-cancelled quotations grouped by status,
 * with age buckets and total pipeline value.
 */
export async function quotationPipeline(connectionId, months = 6) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const since   = monthsBack(months).toISOString().split('T')[0];
  const records = await fetchRaw(config, 'Quotation',
    [['docstatus', '!=', 2], ['creation', '>=', since]],
    ['name', 'party_name', 'creation', 'transaction_date', 'valid_till',
     'grand_total', 'currency', 'status']
  );

  const byStatus  = groupByStatus(records, 'status', 'grand_total', 'currency');
  const totalValue= records.reduce((s, r) => s + parseFloat(r.grand_total || 0), 0);
  const currency  = records[0]?.currency || 'MXN';

  // Age buckets
  const buckets   = { '0-7d': 0, '8-30d': 0, '31-60d': 0, '60d+': 0 };
  for (const r of records) {
    const age = ageDays(r.creation);
    if (age === null) continue;
    if (age <= 7)  buckets['0-7d']++;
    else if (age <= 30) buckets['8-30d']++;
    else if (age <= 60) buckets['31-60d']++;
    else buckets['60d+']++;
  }

  // Individual records (capped at 50 for Claude context)
  const detail = records.slice(0, 50).map(r => ({
    name:       r.name,
    customer:   r.party_name,
    created:    r.creation?.split(' ')[0],
    validTill:  r.valid_till,
    amount:     parseFloat(r.grand_total || 0),
    currency:   r.currency,
    status:     r.status,
    ageDays:    ageDays(r.creation),
  }));

  return {
    stub: false,
    period:     `Last ${months} months`,
    totalCount: records.length,
    totalValue: Math.round(totalValue * 100) / 100,
    currency,
    byStatus,
    ageBuckets: buckets,
    records:    detail,
  };
}

/**
 * Monthly sales totals from Sales Orders.
 * Groups submitted sales orders by month and currency.
 */
export async function monthlySales(connectionId, months = 12) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const since   = monthsBack(months).toISOString().split('T')[0];
  const records = await fetchRaw(config, 'Sales Order',
    [['docstatus', '=', 1], ['transaction_date', '>=', since]],
    ['name', 'customer', 'transaction_date', 'creation', 'grand_total',
     'currency', 'status', 'per_delivered', 'per_billed']
  );

  const byMonth   = groupByMonth(records, 'transaction_date', 'grand_total', 'currency');
  const byStatus  = groupByStatus(records, 'status', 'grand_total', 'currency');
  const thisMonth = records.filter(r => toYearMonth(r.transaction_date) === toYearMonth(new Date().toISOString()));
  const lastMonth = records.filter(r => toYearMonth(r.transaction_date) === toYearMonth(monthsBack(1).toISOString()));

  return {
    stub: false,
    period:        `Last ${months} months`,
    totalOrders:   records.length,
    byMonth:       byMonth.map(m => ({ ...m, total: Math.round(m.total * 100) / 100, label: monthLabel(m.month + '-01') })),
    byStatus,
    thisMonth: {
      count: thisMonth.length,
      total: Math.round(thisMonth.reduce((s, r) => s + parseFloat(r.grand_total || 0), 0) * 100) / 100,
    },
    lastMonth: {
      count: lastMonth.length,
      total: Math.round(lastMonth.reduce((s, r) => s + parseFloat(r.grand_total || 0), 0) * 100) / 100,
    },
  };
}

/**
 * Monthly purchase totals from Purchase Orders.
 */
export async function monthlyPurchases(connectionId, months = 12) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const since   = monthsBack(months).toISOString().split('T')[0];
  const records = await fetchRaw(config, 'Purchase Order',
    [['docstatus', '=', 1], ['transaction_date', '>=', since]],
    ['name', 'supplier', 'transaction_date', 'creation', 'grand_total',
     'currency', 'status', 'per_received', 'per_billed']
  );

  const byMonth  = groupByMonth(records, 'transaction_date', 'grand_total', 'currency');
  const byStatus = groupByStatus(records, 'status', 'grand_total', 'currency');
  const thisMonth= records.filter(r => toYearMonth(r.transaction_date) === toYearMonth(new Date().toISOString()));

  return {
    stub: false,
    period:        `Last ${months} months`,
    totalOrders:   records.length,
    byMonth:       byMonth.map(m => ({ ...m, total: Math.round(m.total * 100) / 100, label: monthLabel(m.month + '-01') })),
    byStatus,
    thisMonth: {
      count: thisMonth.length,
      total: Math.round(thisMonth.reduce((s, r) => s + parseFloat(r.grand_total || 0), 0) * 100) / 100,
    },
  };
}

/**
 * Generic monthly totals for any doctype.
 * Supports custom doctypes added to the registry.
 */
export async function monthlyTotals(connectionId, doctype, dateField, amountField, currencyField, extraFilters = [], months = 12) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const since   = monthsBack(months).toISOString().split('T')[0];
  const records = await fetchRaw(config, doctype,
    [[dateField, '>=', since], ...extraFilters],
    ['name', dateField, amountField, currencyField]
  );

  const byMonth = groupByMonth(records, dateField, amountField, currencyField);
  return {
    stub:   false,
    period: `Last ${months} months`,
    total:  records.length,
    byMonth: byMonth.map(m => ({ ...m, total: Math.round(m.total * 100) / 100, label: monthLabel(m.month + '-01') })),
  };
}

/**
 * Invoice collection report — outstanding amounts and overdue breakdown.
 */
export async function invoiceReport(connectionId) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const records = await fetchRaw(config, 'Sales Invoice',
    [['docstatus', '=', 1], ['outstanding_amount', '>', 0]],
    ['name', 'customer', 'posting_date', 'due_date', 'grand_total',
     'outstanding_amount', 'currency', 'creation']
  );

  const today    = new Date().toISOString().split('T')[0];
  const overdue  = records.filter(r => r.due_date && r.due_date < today);
  const current  = records.filter(r => !r.due_date || r.due_date >= today);
  const totalOut = records.reduce((s, r) => s + parseFloat(r.outstanding_amount || 0), 0);
  const overdueAmt = overdue.reduce((s, r) => s + parseFloat(r.outstanding_amount || 0), 0);
  const currency = records[0]?.currency || 'MXN';

  return {
    stub:           false,
    totalUnpaid:    records.length,
    totalOutstanding: Math.round(totalOut * 100) / 100,
    overdueCount:   overdue.length,
    overdueAmount:  Math.round(overdueAmt * 100) / 100,
    currentCount:   current.length,
    currency,
    records: records.slice(0, 50).map(r => ({
      name:        r.name,
      customer:    r.customer,
      dueDate:     r.due_date,
      outstanding: parseFloat(r.outstanding_amount || 0),
      currency:    r.currency,
      overdue:     r.due_date ? r.due_date < today : false,
      ageDays:     ageDays(r.posting_date),
    })),
  };
}
