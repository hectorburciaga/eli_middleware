import jwt from 'jsonwebtoken';

const SECRET = process.env.MIDDLEWARE_SECRET;

/**
 * Verifies requests to the middleware using the shared MIDDLEWARE_SECRET.
 *
 * Channels (frontend chat, WhatsApp webhook, email listener) must include:
 *   Authorization: Bearer <token signed with MIDDLEWARE_SECRET>
 *
 * The frontend generates its token by calling POST /auth/token with the
 * backend JWT — so users don't need a separate middleware credential.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  try {
    req.caller = jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Issues a short-lived middleware token.
 * Called by the frontend after it has a valid backend JWT.
 * The backend JWT is verified by calling the backend — we don't
 * re-implement JWT verification here, we just trust the backend's /api/settings
 * endpoint as a proxy check (if it returns 200, the backend token is valid).
 */
export function issueMiddlewareToken(channel = 'chat') {
  return jwt.sign({ channel }, SECRET, { expiresIn: '12h' });
}
