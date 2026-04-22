import 'dotenv/config';
import express      from 'express';
import helmet       from 'helmet';
import cors         from 'cors';
import rateLimit    from 'express-rate-limit';
import { requireAuth }    from './middleware/auth.js';
import orchestrateRoutes  from './routes/orchestrate.js';
import authRoutes         from './routes/auth.js';

const PORT    = process.env.PORT    || 3002;
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());

// ── Validate required env vars ────────────────────────────────────────────────
const required = ['ANTHROPIC_API_KEY', 'BACKEND_URL', 'BACKEND_PIN', 'MIDDLEWARE_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`✗ Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet());
app.use(cors({ origin: ORIGINS, credentials: true }));
app.use(express.json({ limit: '2mb' })); // allow larger payloads for forwarded emails

// Rate limiting — tighter than the backend since this hits the Claude API
app.use(rateLimit({
  windowMs:        60_000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests, slow down.' },
}));

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/auth', authRoutes);          // POST /auth/token

// ── Protected routes ──────────────────────────────────────────────────────────
app.use('/orchestrate', requireAuth, orchestrateRoutes);
// POST /orchestrate/chat
// POST /orchestrate/briefing
// POST /orchestrate/ingest

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✓ Middleware orchestrator running on port ${PORT}`);
  console.log(`  Backend API : ${process.env.BACKEND_URL}`);
  console.log(`  Model       : ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'}`);
  console.log(`  Origins     : ${ORIGINS.join(', ')}`);
});
