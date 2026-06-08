// Shared in-memory TTL stores (single-instance; see README for the Redis swap).
import { config } from './config.js';
import { TtlStore } from './idempotency.js';

// Short cache for repeated status lookups within a single call (protects 40/min limit).
export const statusCache = new TtlStore(config.statusCacheTtlMs);

// Dedup: same phone+product register within the window → return the same ticket.
export const registerDedup = new TtlStore(config.idempotencyWindowMs);

// Dedup: Ravan may re-deliver an after-call webhook → process a call_session_id once.
export const callDedup = new TtlStore(config.idempotencyWindowMs);
