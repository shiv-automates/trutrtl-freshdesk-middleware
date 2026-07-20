// ⭐ ONE brand tag, derived once, used by BOTH routes that create a ticket.
//
// routes/register-complaint.js carried the literal 'trutrtl' in its tag list while
// routes/after-call.js derived BRAND_TAG from config.cf.brandValue. Under the default
// CF_BRAND_VALUE the two agree by coincidence, so a test running on the default env can
// never see the drift — this file therefore runs the whole app under a DIFFERENT
// CF_BRAND_VALUE, which is the only condition where the hardcoded copy shows itself.
// If the literal ever comes back, the register assertion below goes red.
//
// ⚠ Env first: lib/config.js reads it at import time and `dotenv/config` never overrides an
// already-set variable, so the operator's real .env cannot leak in. node --test gives this
// file its own process, so the unusual brand value cannot affect the other test files.
process.env.CF_BRAND_VALUE = 'truTRTL Home';   // spaces + case: the derivation must handle both
process.env.RAVAN_SHARED_SECRET = 'test-secret';
process.env.FRESHDESK_DOMAIN = 'stub.freshdesk.com';
process.env.FRESHDESK_API_KEY = 'stub-key';
process.env.WHAPI_ENABLED = 'false';
process.env.TEST_AUTO_CLOSE = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { config, brandTag } = await import('../../src/lib/config.js');
const { createApp } = await import('../../src/app.js');

let calls = [];
let realFetch;
const created = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v2/tickets');

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
    const method = opts.method || 'GET';
    calls.push({ method, path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    assert.equal(u.host, 'stub.freshdesk.com', `test tried to reach ${u.host}`);
    // No contact → after-call has no existing ticket to note on, so it creates one.
    if (method === 'GET' && u.pathname === '/api/v2/search/contacts') return jsonRes(200, { results: [] });
    if (method === 'POST' && u.pathname === '/api/v2/tickets') return jsonRes(201, { id: 12345 });
    if (method === 'POST' && /\/notes$/.test(u.pathname)) return jsonRes(201, { id: 1 });
    throw new Error(`unstubbed ${method} ${u.pathname}`);
  };
});
after(() => { globalThis.fetch = realFetch; });

const server = createApp().listen(0);
after(() => server.close());

async function post(path, body, { auth = 'test-secret', query = '' } = {}) {
  const res = await realFetch(`http://127.0.0.1:${server.address().port}${path}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function waitFor(pred, label, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('⭐ both routes tag a ticket with the SAME config-derived brand tag', async () => {
  assert.equal(config.cf.brandValue, 'truTRTL Home');
  assert.equal(brandTag, 'trutrtl_home', 'the tag is derived from CF_BRAND_VALUE, not hardcoded');

  calls = [];
  const reg = await post('/freshdesk/register-complaint', {
    name: 'Priya Sharma',
    phone_number: '9876543210',
    product: 'ceiling fan',
    platform: 'Amazon',
    issue_description: 'It stopped spinning after two weeks',
  });
  assert.equal(reg.complaint_number, '12345');
  const regTags = created()[0].body.tags;
  // ⭐ THE ASSERTION THAT CATCHES THE DRIFT: with a non-default brand value, a hardcoded
  // 'trutrtl' would still be sitting in this list and 'trutrtl_home' would be missing.
  assert.ok(regTags.includes(brandTag), `register tags ${JSON.stringify(regTags)} must carry ${brandTag}`);
  assert.ok(!regTags.includes('trutrtl'), 'the hardcoded literal must be gone');
  // Nothing else about the tag list changed.
  assert.deepEqual([...regTags].sort(), ['trutrtl_home', 'voice_agent', 'warranty']);

  calls = [];
  await post('/ravan/after-call', {
    data: {
      call_id: 'bt1', phone: '9111111111', summary: 'Ceiling fan not spinning',
      product: 'ceiling fan', platform: 'Amazon',
    },
  }, { auth: '', query: '?key=test-secret' });
  await waitFor(() => created().length > 0, 'the after-call ticket create');
  const callTags = created()[0].body.tags;
  assert.ok(callTags.includes(brandTag), `after-call tags ${JSON.stringify(callTags)} must carry ${brandTag}`);

  // The point of the whole exercise: one desk, one brand tag, whatever CF_BRAND_VALUE says.
  assert.equal(
    regTags.find((t) => t.startsWith('trutrtl')),
    callTags.find((t) => t.startsWith('trutrtl')),
    'the two routes must never tag the same desk differently',
  );
});
