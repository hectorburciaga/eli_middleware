import fetch from 'node-fetch';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const PIN         = process.env.BACKEND_PIN;

let _token    = null;
let _tokenExp = 0;

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const res  = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ pin: PIN }),
  });

  if (!res.ok) throw new Error(`Backend auth failed: ${res.status}`);
  const { token } = await res.json();
  _token    = token;
  _tokenExp = Date.now() + 6 * 24 * 60 * 60 * 1000; // refresh 1 day before expiry
  return token;
}

// ── Base fetch ────────────────────────────────────────────────────────────────
async function call(path, options = {}) {
  const token = await getToken();
  const res   = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    _token = null; // force re-auth on next call
    throw new Error('Backend token expired — will retry');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Backend error ${res.status}`);
  }

  return res.status === 204 ? null : res.json();
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
export const getTasks       = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return call(`/api/tasks${qs ? '?' + qs : ''}`);
};
export const getTaskSummary = ()         => call('/api/tasks/summary');
export const createTask     = (data)     => call('/api/tasks',      { method: 'POST',  body: data });
export const updateTask     = (id, data) => call(`/api/tasks/${id}`,{ method: 'PATCH', body: data });
export const deleteTask     = (id)       => call(`/api/tasks/${id}`,{ method: 'DELETE' });

// ── Projects ──────────────────────────────────────────────────────────────────
export const getProjects = () => call('/api/projects');

// ── Connections ───────────────────────────────────────────────────────────────
export const getConnections = () => call('/api/connections');
export const getConnection  = (id) => call(`/api/connections/${id}`);

// ── Settings ──────────────────────────────────────────────────────────────────
export const getSettings = () => call('/api/settings');
