// ⭐ The by-phone lookback. Run with: npm test
//
// ONE defect, and it is invisible from the code: Freshdesk's GET /tickets returns only
// tickets created in the LAST 30 DAYS unless `updated_since` is supplied. getTicketsByRequester()
// never sent it, so the lookup a caller reaches by giving nothing but a mobile number could
// not see a 31-day-old ticket — while defect 20 ("day 32 must NOT speak like day 2") is
// explicitly about the one-month-old complaint. The caller got found:false on a ticket that
// exists, sla_breached could never fire on that path, and the brand filter was choosing from
// a truncated list, so an older truTRTL ticket could hide behind a newer one from another brand.
//
// ⚠ Env is set BEFORE importing anything — lib/config.js reads it at import time, and
// `dotenv/config` never overrides a variable that is already set, so the operator's real
// .env cannot leak into this run. globalThis.fetch is intercepted, so nothing here touches
// the live shared desk (digicart.freshdesk.com).
process.env.FRESHDESK_DOMAIN = 'stub.freshdesk.com';
process.env.FRESHDESK_API_KEY = 'stub-key';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const fd = await import('../../src/lib/freshdesk.js');

let calls = [];
let realFetch;

const jsonRes = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(data),
});

before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', path: u.pathname, query: u.searchParams });
    assert.equal(u.host, 'stub.freshdesk.com', `test tried to reach ${u.host}`);
    if (u.pathname === '/api/v2/tickets') return jsonRes(200, [{ id: 11914 }]);
    throw new Error(`unstubbed ${u.pathname}`);
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });

test('⭐ the by-phone lookup asks for TWO YEARS, not Freshdesk\'s silent 30 days', async () => {
  const out = await fd.getTicketsByRequester(900);
  assert.deepEqual(out, [{ id: 11914 }]);
  assert.equal(calls.length, 1, 'one call — the account has a ~40 req/min shared budget');

  const q = calls[0].query;
  const since = q.get('updated_since');
  assert.ok(
    since,
    'updated_since is MISSING — GET /tickets then returns only the last 30 days, so a '
    + '32-day-old complaint comes back found:false and sla_breached can never fire.',
  );
  // Freshdesk wants ISO 8601; milliseconds are not part of the documented shape.
  assert.match(since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `updated_since shape: ${since}`);

  const days = (Date.now() - Date.parse(since)) / 86400000;
  assert.ok(days > 400, `lookback is only ${Math.round(days)} days — a 1-year warranty needs more`);
  assert.ok(days < 1100, `lookback is ${Math.round(days)} days — wider than intended`);

  // The rest of the query is unchanged: newest first, with the stats include the SLA read
  // and the status enrichment both depend on.
  assert.equal(q.get('requester_id'), '900');
  assert.equal(q.get('order_by'), 'created_at');
  assert.equal(q.get('order_type'), 'desc');
  assert.equal(q.get('include'), 'stats');
});

test('the lookback window comfortably covers the one-month-old complaint of defect 20', () => {
  const { REQUESTER_LOOKBACK_DAYS, lookbackISO } = fd._internals;
  assert.equal(REQUESTER_LOOKBACK_DAYS, 730);

  // The two dates the old 30-day default silently hid.
  const now = new Date('2026-07-18T12:00:00Z');
  const since = Date.parse(lookbackISO(REQUESTER_LOOKBACK_DAYS, now));
  for (const daysOld of [32, 45, 180, 365, 700]) {
    assert.ok(
      Date.parse(now) - (daysOld * 86400000) > since,
      `a ${daysOld}-day-old ticket must fall INSIDE the window`,
    );
  }
  assert.equal(lookbackISO(730, now), '2024-07-18T12:00:00Z');   // exactly two years back
});
