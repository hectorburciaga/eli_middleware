# Task Manager — Middleware Orchestrator

AI orchestration layer. Sits between the frontend/channels and the backend API.
Calls Claude with full task context, executes actions, and returns responses.

Runs on the same VM as the backend on port 3002.

---

## Architecture

```
Frontend (3000)  ─┐
WhatsApp webhook  ├──▶  Middleware (3002)  ──▶  Backend API (3001)  ──▶  SQLite
Email listener   ─┘         │
                             └──▶  Claude API (Anthropic)
                             └──▶  Frappe/ERP (when configured)
                             └──▶  Files (Phase 6)
```

---

## Setup (on the same VM as the backend)

```bash
# Upload and unpack
scp task-manager-middleware.zip user@YOUR_VM:/opt/
cd /opt
unzip task-manager-middleware.zip
mv task-manager-middleware /opt/middleware
cd /opt/middleware

# Configure
cp .env.example .env
chmod 600 .env
nano .env
# Fill in: ANTHROPIC_API_KEY, BACKEND_PIN, MIDDLEWARE_SECRET
# Generate MIDDLEWARE_SECRET:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Install and start
npm install
npm start
```

### Systemd service

```ini
# /etc/systemd/system/middleware.service
[Unit]
Description=Task Manager Middleware
After=network.target task-manager.service

[Service]
Type=simple
User=taskmanager
WorkingDirectory=/opt/middleware
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/middleware/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now middleware
sudo journalctl -u middleware -f
```

---

## API Reference

### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/auth/token` | `{ backendToken }` | Exchange backend JWT for middleware token |

All `/orchestrate/*` endpoints require `Authorization: Bearer <middleware_token>`.

---

### Orchestrate

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/orchestrate/chat` | `{ message, history?, channel? }` | Main chat endpoint |
| POST | `/orchestrate/briefing` | `{ lang? }` | Generate daily briefing |
| POST | `/orchestrate/ingest` | `{ text, source }` | Extract tasks from forwarded message |

#### Chat response
```json
{
  "reply": "You have 2 urgent tasks...",
  "actionResult": { "id": 7, "title": "...", "status": "Inbox" },
  "context": { "urgentCount": 2, "overdueCount": 1, "totalActive": 6 }
}
```

#### Ingest response
```json
{
  "tasks": [
    { "title": "Follow up with client", "priority": "Important", "projectId": "iaarq", "due": "2026-04-25" }
  ],
  "source": "whatsapp"
}
```

---

## Adding new tools

Each tool is a file in `src/tools/`. To add a new integration:

1. Create `src/tools/mytool.js` with your connector logic
2. Load connection config via `backend.getConnection(connectionId)` — never hardcode credentials
3. Import and call your tool from `src/routes/orchestrate.js` when Claude needs it
4. Add a stub response for when the connection isn't configured yet

---

## Connecting the frontend chat to the middleware

Update `src/lib/api.js` in the frontend to add:

```js
const MIDDLEWARE_URL = process.env.NEXT_PUBLIC_MIDDLEWARE_URL || 'http://localhost:3002';

export const getMiddlewareToken = (backendToken) =>
  fetch(`${MIDDLEWARE_URL}/auth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ backendToken }),
  }).then(r => r.json());

export const chat = (token, message, history = []) =>
  fetch(`${MIDDLEWARE_URL}/orchestrate/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ message, history }),
  }).then(r => r.json());
```
