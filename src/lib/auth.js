// Bearer-token guard for incoming Ravan → middleware requests.
import { config } from './config.js';

/** Constant-time-ish string compare to avoid trivial timing leaks. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Express middleware: require "Authorization: Bearer <RAVAN_SHARED_SECRET>". */
export function requireBearer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !safeEqual(token, config.ravanSharedSecret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
