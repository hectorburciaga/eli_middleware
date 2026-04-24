import fetch from 'node-fetch';
import * as backend from '../lib/backendClient.js';

/**
 * Metabase connector.
 * Credentials loaded from the connection registry — not hardcoded.
 * Connection type id: 'metabase' (add to CONNECTION_TYPES in backend if not present)
 *
 * Supports:
 *   - Session-based auth (username + password) → auto-renews token
 *   - API key auth (Metabase Pro/Enterprise)
 */

// ── Session cache (per connection id) ────────────────────────────────────────
const sessionCache = {};

async function getConnectionConfig(connectionId) {
  try {
    const conn = await backend.getConnection(connectionId);
    if (!conn || conn.status !== 'configured') return null;
    return { ...conn.config, _connId: connectionId };
  } catch { return null; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getSessionToken(config) {
  // If API key is provided, use that directly (Metabase Pro/Enterprise)
  if (config.api_key) return null; // signals to use X-API-Key header instead

  const cache = sessionCache[config._connId];
  if (cache && cache.expires > Date.now()) return cache.token;

  const res = await fetch(`${config.url}/api/session`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username: config.username, password: config.password }),
  });

  if (!res.ok) throw new Error(`Metabase auth failed: ${res.status}`);
  const { id } = await res.json();

  sessionCache[config._connId] = { token: id, expires: Date.now() + 13 * 60 * 60 * 1000 }; // 13h
  return id;
}

async function mbFetch(config, path, options = {}) {
  const token = await getSessionToken(config);
  const headers = { 'Content-Type': 'application/json' };

  if (config.api_key) {
    headers['X-API-Key'] = config.api_key;
  } else {
    headers['X-Metabase-Session'] = token;
  }

  const res = await fetch(`${config.url}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `Metabase error ${res.status}`);
  }

  return res.json();
}

// ── Format result rows into a readable table for Claude ───────────────────────
function formatResults(data) {
  const cols = data.data?.cols?.map(c => c.display_name || c.name) || [];
  const rows = data.data?.rows || [];

  if (!rows.length) return { cols, rows: [], summary: 'No data returned.' };

  // Build summary line
  const summary = `${rows.length} row${rows.length !== 1 ? 's' : ''} returned`;

  // Convert rows to objects
  const records = rows.map(row =>
    Object.fromEntries(cols.map((col, i) => [col, row[i]]))
  );

  return { cols, rows: records, summary, rowCount: rows.length };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List all saved questions (cards) the session has access to.
 * Optionally filter by collection name to scope to one ERP.
 */
export async function listQuestions(connectionId, collectionFilter = null) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const cards = await mbFetch(config, '/api/card?f=all');
  const questions = cards
    .filter(c => c.type === 'question' || c.type === 'model')
    .filter(c => !collectionFilter || c.collection?.name?.toLowerCase().includes(collectionFilter.toLowerCase()))
    .map(c => ({
      id:          c.id,
      name:        c.name,
      description: c.description,
      collection:  c.collection?.name || 'Root',
      creator:     c.creator?.common_name,
      updatedAt:   c.updated_at?.split('T')[0],
    }));

  return { stub: false, questions };
}

/**
 * Run a saved question by its numeric ID.
 * Returns formatted results ready for Claude.
 */
export async function runQuestion(connectionId, questionId) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const data = await mbFetch(config, `/api/card/${questionId}/query`, { method: 'POST' });
  return { stub: false, questionId, ...formatResults(data) };
}

/**
 * Run a saved question with dynamic parameters (date filters etc).
 * parameters: [{ type: 'date/single', target: [...], value: '2026-04-01' }]
 */
export async function runQuestionWithParams(connectionId, questionId, parameters = []) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const data = await mbFetch(config, `/api/card/${questionId}/query`, {
    method: 'POST',
    body:   { parameters },
  });
  return { stub: false, questionId, ...formatResults(data) };
}

/**
 * Get metadata about a question — useful for Claude to understand
 * what a question returns before running it.
 */
export async function getQuestionInfo(connectionId, questionId) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const card = await mbFetch(config, `/api/card/${questionId}`);
  return {
    stub:        false,
    id:          card.id,
    name:        card.name,
    description: card.description,
    collection:  card.collection?.name,
    columns:     card.result_metadata?.map(m => ({ name: m.display_name, type: m.base_type })) || [],
  };
}

/**
 * Search questions by name — Claude uses this to find relevant questions.
 */
export async function searchQuestions(connectionId, query) {
  const config = await getConnectionConfig(connectionId);
  if (!config) return { stub: true };

  const results = await mbFetch(config, `/api/search?q=${encodeURIComponent(query)}&models=card`);
  const questions = (results.data || []).map(c => ({
    id:          c.id,
    name:        c.name,
    description: c.description,
    collection:  c.collection_name,
  }));

  return { stub: false, questions };
}
