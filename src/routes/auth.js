import { Router } from 'express';
import { issueMiddlewareToken } from '../middleware/auth.js';
import * as backend from '../lib/backendClient.js';

const router = Router();

/**
 * POST /auth/token
 *
 * The frontend calls this after logging in to the backend.
 * It passes its backend JWT; we verify it by calling the backend's
 * /api/settings (if that succeeds, the token is valid), then issue
 * a short-lived middleware token.
 *
 * Body: { backendToken: string }
 */
router.post('/token', async (req, res) => {
  const { backendToken } = req.body;
  if (!backendToken) return res.status(400).json({ error: 'backendToken is required' });

  try {
    // Proxy-verify by hitting a protected backend endpoint
    const fetch = (await import('node-fetch')).default;
    const check = await fetch(`${process.env.BACKEND_URL}/api/settings`, {
      headers: { Authorization: `Bearer ${backendToken}` },
    });

    if (!check.ok) return res.status(401).json({ error: 'Invalid backend token' });

    const token = issueMiddlewareToken('chat');
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
