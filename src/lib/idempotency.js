// Tiny in-memory TTL store used for two things:
//   1. register dedup  — avoid creating duplicate tickets on retries (key = phone+product)
//   2. after-call dedup — avoid double-logging when Ravan re-delivers a webhook (key = call_session_id)
//   3. status cache     — short-lived cache so repeated status lookups in one call don't burn the 40/min budget
//
// NOTE: single-instance only. On Render (one always-on instance) this is fine.
// For multi-instance/serverless, swap for Redis (see README).

export class TtlStore {
  constructor(defaultTtlMs) {
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map(); // key -> { value, expires }
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    this._sweep();
    return value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  _sweep() {
    if (this.map.size < 256) return; // cheap cap; only sweep when it grows
    const now = Date.now();
    for (const [k, e] of this.map) if (e.expires <= now) this.map.delete(k);
  }
}

export function normalizeKey(...parts) {
  return parts.map((p) => String(p ?? '').trim().toLowerCase()).join('|');
}
