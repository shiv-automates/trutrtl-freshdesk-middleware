// Route-level tests against a STUBBED Freshdesk. globalThis.fetch is intercepted for the
// whole file, so nothing here touches the network and no ticket is ever created on the
// live shared desk (digicart.freshdesk.com).
//
// These cover the four backported fixes that would be incidents rather than bugs: the
// brand filter, the identity gate, the honest-failure path (plus dedup honesty), and the
// after-call auth hole.
//
// ⚠ Env is set BEFORE importing anything — lib/config.js reads it at import time, and
// `dotenv/config` never overrides a variable that is already set, so the operator's real
// .env cannot leak into this run. WHAPI and TEST_AUTO_CLOSE are forced OFF: the first
// would send a real WhatsApp, the second would make the asserted tag list machine-dependent.
process.env.RAVAN_SHARED_SECRET = 'test-secret';
process.env.FRESHDESK_DOMAIN = 'stub.freshdesk.com';
process.env.FRESHDESK_API_KEY = 'stub-key';
process.env.WHAPI_ENABLED = 'false';
process.env.TEST_AUTO_CLOSE = 'false';
process.env.COMPLAINT_ID_MODE = 'TICKET_ID';
process.env.IDEMPOTENCY_WINDOW_MS = '300000';
process.env.STATUS_CACHE_TTL_MS = '30000';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { config } = await import('../../src/lib/config.js');
const { createApp } = await import('../../src/app.js');
const { ORDER_DATE_NOT_CAPTURED } = await import('../../src/lib/ticket-fields.js');
// register-complaint now answers the caller BEFORE its notes/WhatsApp/auto-close, exactly
// as after-call has always done. drainBackgroundWork() awaits that trailing work so one
// test's bookkeeping can never appear in the next test's request log.
const { drainBackgroundWork } = await import('../../src/routes/register-complaint.js');

const CF = config.cf;
const BRAND = CF.brandValue;

// ── Freshdesk stub ───────────────────────────────────────────────────────────

const ticketFixture = (id, brand, extra = {}) => ({
  id,
  status: 3,
  created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
  custom_fields: {
    [CF.brand]: brand,
    [CF.product]: 'Ceiling Fan',
    [CF.productCategory]: 'Ceiling Fans',
  },
  requester: { name: 'Priya Sharma' },
  conversations: [
    { body_text: 'Dear Customer, your replacement is approved.', private: true, created_at: new Date().toISOString() },
  ],
  ...extra,
});

const TICKETS = {
  11914: ticketFixture(11914, BRAND),      // ours
  11915: ticketFixture(11915, 'MILTON'),   // another brand, adjacent id in the SHARED sequence
  // Ours, parked in a real ops queue — the raw name of which must never cross the wire.
  11916: ticketFixture(11916, BRAND, {
    custom_fields: {
      [CF.brand]: BRAND,
      [CF.product]: 'Ceiling Fan',
      [CF.groupCustom]: 'Rapid Era',
    },
  }),
};

let calls = [];               // every request the middleware made to "Freshdesk"
let realFetch;
const posts = (path) => calls.filter((c) => c.method === 'POST' && c.path.endsWith(path));

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
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: u.pathname, query: u.searchParams, body });

    // Any host other than the stub means a test escaped the sandbox.
    assert.equal(u.host, 'stub.freshdesk.com', `test tried to reach ${u.host}`);

    const m = /^\/api\/v2\/tickets\/(\d+)$/.exec(u.pathname);
    if (method === 'GET' && m) {
      const t = TICKETS[m[1]];
      return t ? jsonRes(200, t) : jsonRes(404, null);
    }
    if (method === 'GET' && u.pathname === '/api/v2/search/contacts') {
      // 9111111111 is a caller we have never seen — no contact, therefore no ticket.
      const q = u.searchParams.get('query') || '';
      return jsonRes(200, { results: q.includes('9111111111') ? [] : [{ id: 900 }] });
    }
    if (method === 'GET' && u.pathname === '/api/v2/tickets') {
      // One contact on this shared desk holds tickets across brands — MILTON's is NEWER.
      return jsonRes(200, [TICKETS[11915], TICKETS[11914]]);
    }
    if (method === 'POST' && u.pathname === '/api/v2/tickets') return jsonRes(201, { id: 12345 });
    if (method === 'POST' && /\/notes$/.test(u.pathname)) return jsonRes(201, { id: 1 });
    if (method === 'PUT' && m) return jsonRes(200, {});
    throw new Error(`unstubbed ${method} ${u.pathname}`);
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(async () => { await drainBackgroundWork(); calls = []; });

// ── Harness ──────────────────────────────────────────────────────────────────

const server = createApp().listen(0);
const port = () => server.address().port;
after(() => server.close());

async function post(path, body, { auth = 'test-secret', query = '' } = {}) {
  const res = await realFetch(`http://127.0.0.1:${port()}${path}${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const status = (body) => post('/freshdesk/complaint-status', body);
const register = (body) => post('/freshdesk/register-complaint', body);

// after-call 200s BEFORE it does its Freshdesk work, so its tests have to wait for the
// work rather than for the response. Poll for the call we expect (fast + not flaky on a
// slow machine); for the "nothing must happen" assertions, wait for the one request that
// path always makes (the contact search) and then confirm nothing followed it.
const gets = (path) => calls.filter((c) => c.method === 'GET' && c.path === path);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, label, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await settle(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}
const contactSearched = () => waitFor(
  () => gets('/api/v2/search/contacts').length > 0, 'the after-call contact search',
);

const VALID = {
  name: 'Priya Sharma',
  phone_number: '9876543210',
  product: 'ceiling fan',
  platform: 'Amazon',
  issue_description: 'It stopped spinning after two weeks',
  order_id: 'AMZ-123',
  purchase_date: '2026-05-01',
  city: 'Mumbai', state: 'Maharashtra', pincode: '400001',
};

// ── ⭐ complaint-status: the brand filter ─────────────────────────────────────

test("⭐ by-id: another brand's ticket is indistinguishable from a genuine miss", async () => {
  const r = await status({ complaint_number: '11915', caller_stated_name: 'Priya' });
  assert.equal(r.status, 200);
  // Exactly what a real miss returns — no "wrong brand", no hint that the ticket exists,
  // because its existence is itself information about another brand's customer.
  assert.deepEqual(r.body, { found: false });
});

test('by-id: a ticket id nobody holds is the same answer again', async () => {
  const r = await status({ complaint_number: '99999', caller_stated_name: 'Priya' });
  assert.deepEqual(r.body, { found: false });
});

test('by-id: our own ticket + a matching name returns the full case detail', async () => {
  const r = await status({ complaint_number: '11914', caller_stated_name: 'Priya' });
  assert.equal(r.body.found, true);
  assert.equal(r.body.name_matches, true);
  assert.equal(r.body.complaint_number, '11914');
  assert.equal(r.body.product, 'Ceiling Fan');
  assert.match(r.body.latest_update, /replacement is approved/);
});

test('⭐ by-phone: picks OUR ticket, never the newer cross-brand one on the same contact', async () => {
  const r = await status({ phone_number: '9876543210', caller_stated_name: 'Priya Sharma' });
  assert.equal(r.body.found, true);
  // MILTON's #11915 is FIRST in the list (newest); the brand filter must skip it.
  assert.equal(r.body.complaint_number, '11914');
});

test('⭐ the raw ops queue never crosses the wire, even to a caller who passed the gate', async () => {
  // #11916 sits in the 'Rapid Era' queue. The response is read by an LLM under a heading
  // that says "Tara reads this aloud", so the raw string was one RAG miss away from being
  // said to a customer. Only the client's own customer-facing phrasing may ship.
  const r = await status({ complaint_number: '11916', caller_stated_name: 'Priya' });
  assert.equal(r.body.found, true);
  assert.equal(r.body.name_matches, true);
  assert.equal(r.body.queue, undefined, 'the raw queue field must not exist on the wire');

  const blob = JSON.stringify(r.body);
  for (const raw of ['Rapid Era', 'with digiCART', 'digiCART', 'No Comm from Customer']) {
    assert.ok(!blob.includes(raw), `raw ops vocabulary reached the voice agent: ${raw}`);
  }
  // The meaning survives — that is what makes dropping the raw value safe.
  assert.match(r.body.queue_spoken, /service centre/i);
});

// ── ⭐ complaint-status: the identity gate ────────────────────────────────────

test('⭐ identity gate: a wrong name confirms only that a complaint exists', async () => {
  const r = await status({ complaint_number: '11914', caller_stated_name: 'Rahul Mehta' });
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.equal(r.body.name_matches, false);
  assert.equal(r.body.product, undefined);
  assert.equal(r.body.latest_update, undefined);
  assert.equal(r.body.status_label, undefined);
  assert.equal(r.body.days_since_registered, undefined);
  assert.equal(r.body.expected_next_step, undefined);
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes('priya'),
    'the requester name must never cross the wire');
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes('sharma'));
});

test('⭐ identity gate: NO name given → nothing case-specific', async () => {
  const r = await status({ complaint_number: '11914' });
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.equal(r.body.name_matches, false);
  assert.deepEqual(Object.keys(r.body).sort(), ['complaint_number', 'found', 'name_matches']);
});

test('the cache cannot launder a failed identity gate into a passed one', async () => {
  // First caller passes the gate and warms the cache.
  const first = await status({ complaint_number: '11914', caller_stated_name: 'Priya' });
  assert.equal(first.body.name_matches, true);

  // Second caller, same ticket id (cache is warm — no new Freshdesk fetch), wrong name.
  // If the CACHED PAYLOAD were replayed, this would hand him the case detail.
  calls = [];
  const second = await status({ complaint_number: '11914', caller_stated_name: 'Rahul' });
  assert.equal(calls.length, 0, 'expected a cache hit (otherwise this test proves nothing)');
  assert.equal(second.body.name_matches, false);
  assert.equal(second.body.product, undefined);
  assert.equal(second.body.latest_update, undefined);
});

test('a missing identifier is a 200 with a voice-shaped reason, not a 400', async () => {
  const r = await status({});
  assert.equal(r.status, 200);
  assert.equal(r.body.found, false);
  assert.equal(r.body.reason, 'missing_identifier');
  assert.ok(r.body.spoken_hint);
  assert.equal(calls.length, 0);
});

test('complaint-status requires the Bearer token', async () => {
  const body = { complaint_number: '11914' };
  assert.equal((await post('/freshdesk/complaint-status', body, { auth: '' })).status, 401, 'no token');
  assert.equal((await post('/freshdesk/complaint-status', body, { auth: 'wrong' })).status, 401, 'wrong token');
  assert.equal(calls.length, 0, 'an unauthenticated lookup must never reach Freshdesk');
  assert.equal((await post('/freshdesk/complaint-status', body)).status, 200, 'right token');
});

// ── ⭐ register-complaint: the honest-failure path ────────────────────────────

test("a fileable complaint is created, and the payload mirrors digiCART's intake shape", async () => {
  const r = await register({ ...VALID, phone_number: '9000000001' });
  assert.equal(r.status, 200);
  assert.equal(r.body.complaint_number, '12345');

  const created = posts('/api/v2/tickets')[0].body;
  assert.equal(created.custom_fields[CF.brand], BRAND);
  assert.equal(created.custom_fields[CF.productCategory], 'Ceiling Fans');
  assert.equal(created.custom_fields[CF.productSku], 'Trutrtl-Smart-1200 MM');
  assert.equal(created.custom_fields[CF.platform], 'Amazon');
  assert.match(created.description, new RegExp(`^Brand: ${BRAND}$`, 'm'));

  // KEEP BYTE-FOR-BYTE — digiCART's intake automation parses this subject, space before
  // the comma included.
  assert.match(created.subject, /^Complaint Date- \d{2}\.\d{2}\.\d{4}, Order Date: 01-05-2026 , Order ID- AMZ-123$/);

  // No per-phrase issue tag (the tag explosion): the issue text lives in the description.
  assert.deepEqual([...created.tags].sort(), ['trutrtl', 'voice_agent', 'warranty']);
  assert.ok(!created.tags.some((t) => /stopped spinning/i.test(t)));
});

test('⭐ an unfileable category is refused honestly — no ticket, no fabricated number', async () => {
  // Induction / Cooker / Iron are in Tara's enum and in cf_custom_tags but have NO node in
  // the 7-category brand tree. They used to be filed as CEILING FANS with the fabricated
  // model 'Trutrtl-Smart-1200 MM'.
  for (const product of ['induction', 'pressure cooker', 'steam iron']) {
    calls = [];
    const r = await register({ ...VALID, phone_number: '9000000002', product });
    assert.equal(r.status, 200, `${product}: never a non-200 to the voice agent`);
    assert.equal(r.body.error, true);
    assert.equal(r.body.reason, 'category_unavailable', `${product}: reason`);
    assert.ok(r.body.spoken_hint, `${product}: Tara needs something safe to say`);
    assert.equal(r.body.complaint_number, undefined, 'Tara must have no number to read back');
    assert.equal(posts('/api/v2/tickets').length, 0, 'a create would have 400d — it must not be attempted');
  }
});

test('⭐ "induction stove" is refused too — the stove rule must not file it as a Gas Stove', async () => {
  // The honest-failure bypass. mapCategory() matches the RAW text independently of the
  // product vocabulary, and its /\b(gas\s*stove|stove|cooktop|hob)\b/ rule claims all of
  // these — so the unfilable-product check, which only ran when mapCategory() returned
  // null, never fired. A caller with a broken induction was read back a complaint number
  // for a ticket filed as GAS STOVES / 'Shakti 2B', which ops routes a technician from.
  for (const product of [
    'induction stove', 'induction cooktop', 'induction hob', 'electric induction stove',
    'my induction stove is not heating', 'cooker hob',
  ]) {
    calls = [];
    const r = await register({ ...VALID, phone_number: '9000000007', product });
    assert.equal(r.status, 200, `${product}: never a non-200 to the voice agent`);
    assert.equal(r.body.error, true, `${product}: must be an honest failure`);
    assert.equal(r.body.reason, 'category_unavailable', `${product}: reason`);
    assert.ok(r.body.spoken_hint, `${product}: Tara needs something safe to say`);
    assert.equal(r.body.complaint_number, undefined, 'Tara must have no number to read back');
    assert.equal(posts('/api/v2/tickets').length, 0, `${product}: nothing may be created`);
  }

  // The positive control that makes the test mean something: a GENUINE gas stove is
  // untouched by the precedence change and still files against the real chain.
  calls = [];
  const ok = await register({ ...VALID, phone_number: '9000000008', product: '3 burner gas stove' });
  assert.equal(ok.body.complaint_number, '12345');
  const created = posts('/api/v2/tickets')[0].body;
  assert.equal(created.custom_fields[CF.productCategory], 'Gas Stoves');
  assert.equal(created.custom_fields[CF.productSku], 'Shakti 2B');
});

test('⭐ Meesho / Jabong FILE — as themselves, never as a Website purchase', async () => {
  // ⭐ 2026-07-20. These two used to be a terminal `unmapped_channel` refusal: the caller got
  // no ticket and a promised callback, because cf_purchased_from had no value for them. The
  // admin added both, so the refusal became the defect. What must NOT come back is the old
  // §9.1 #8 behaviour of quietly filing them as 'Website' — that decides which return policy
  // applies and which invoice we ask the customer for.
  let i = 0;
  for (const [platform, expected] of [
    ['Meesho', 'Meesho'], ['Jabong', 'Jabong'],
    ['bought it on the meesho website', 'Meesho'],
  ]) {
    await drainBackgroundWork();
    calls = [];
    const r = await register({
      ...VALID, phone_number: `900000030${i++}`, platform, issue_description: `blades wobble ${platform}`,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.error, undefined, `${platform}: must not be an honest failure any more`);
    assert.equal(r.body.complaint_number, '12345', `${platform}: the caller gets a real number`);
    assert.equal(posts('/api/v2/tickets').length, 1, `${platform}: exactly one ticket`);
    assert.equal(posts('/api/v2/tickets')[0].body.custom_fields[CF.platform], expected,
      `${platform}: cf_purchased_from must be ${expected}, never Website`);
  }
});

test('an unmapped platform is refused rather than defaulted to Website', async () => {
  const r = await register({ ...VALID, phone_number: '9000000003', platform: 'the corner store' });
  assert.equal(r.body.error, true);
  assert.equal(r.body.reason, 'unmapped_platform');
  assert.ok(r.body.spoken_hint);
  assert.equal(r.body.complaint_number, undefined);
  assert.equal(posts('/api/v2/tickets').length, 0);
});

test('an unmapped product is refused rather than filed under a guessed category', async () => {
  const r = await register({ ...VALID, phone_number: '9000000004', product: 'dishwasher' });
  assert.equal(r.body.error, true);
  assert.equal(r.body.reason, 'unmapped_product');
  assert.ok(r.body.spoken_hint);
  assert.equal(r.body.complaint_number, undefined);
  assert.equal(posts('/api/v2/tickets').length, 0);
});

test('missing required params answer 200 with a reason, not a 400', async () => {
  const r = await register({ name: 'Priya' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'missing_required');
  assert.ok(r.body.missing.includes('phone_number'));
  assert.equal(r.body.complaint_number, undefined);
  assert.equal(calls.length, 0);
});

test('register-complaint requires the Bearer token', async () => {
  assert.equal((await post('/freshdesk/register-complaint', VALID, { auth: '' })).status, 401);
  assert.equal((await post('/freshdesk/register-complaint', VALID, { auth: 'wrong' })).status, 401);
  assert.equal(calls.length, 0, 'an unauthenticated register must never reach Freshdesk');
});

// ── register-complaint: dedup honesty ────────────────────────────────────────

test('⭐ a genuine SECOND complaint is filed, and a true retry is deduped', async () => {
  const phone = '9000000005';
  const first = await register({ ...VALID, phone_number: phone });
  assert.equal(first.body.complaint_number, '12345');

  // A real retry (identical params) → the same id, and no second ticket.
  await drainBackgroundWork();
  calls = [];
  const retry = await register({ ...VALID, phone_number: phone });
  assert.equal(retry.body.complaint_number, '12345');
  assert.equal(posts('/api/v2/tickets').length, 0, 'a retry must not create a second ticket');

  // A DIFFERENT issue on the same phone+category → the old key (phone+product) handed
  // back the first ticket's id for a complaint it never filed. It must be filed.
  await drainBackgroundWork();
  calls = [];
  const second = await register({ ...VALID, phone_number: phone, issue_description: 'The blade came loose' });
  assert.equal(posts('/api/v2/tickets').length, 1, 'a genuine second complaint must create a ticket');
  assert.equal(second.body.complaint_number, '12345');
});

test('⭐ concurrent duplicate registrations create exactly one ticket (the dedup race)', async () => {
  const p = { ...VALID, phone_number: '9000000006' };
  const [a, b] = await Promise.all([register(p), register(p)]);
  assert.equal(a.body.complaint_number, '12345');
  assert.equal(b.body.complaint_number, '12345');
  assert.equal(posts('/api/v2/tickets').length, 1, 'the dedup slot must be reserved BEFORE the create');
});

// ── ⭐ after-call: the auth hole ──────────────────────────────────────────────

test('⭐ after-call rejects an OMITTED ?key (the old guard passed it straight through)', async () => {
  const r = await post('/ravan/after-call', { data: { call_id: 'c1', phone: '9876543210' } }, { auth: '' });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { ok: false });
  await settle();
  assert.equal(calls.length, 0, 'no Freshdesk work may happen for an unauthenticated webhook');
});

test('⭐ after-call rejects a wrong ?key and accepts the right one', async () => {
  const bad = await post('/ravan/after-call', { data: { call_id: 'c2' } }, { auth: '', query: '?key=nope' });
  assert.equal(bad.status, 401);
  // A near-miss (prefix of the real secret) must not slip through either.
  const near = await post('/ravan/after-call', { data: { call_id: 'c2b' } }, { auth: '', query: '?key=test-secre' });
  assert.equal(near.status, 401);
  await settle();
  assert.equal(calls.length, 0);

  const ok = await post('/ravan/after-call', { data: { call_id: 'c3' } }, { auth: '', query: '?key=test-secret' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
});

test("after-call: a truTRTL caller's note lands on the truTRTL ticket, not the cross-brand one", async () => {
  await post('/ravan/after-call', {
    data: { call_id: 'c4', phone: '9876543210', summary: 'Ceiling fan not spinning' },
  }, { auth: '', query: '?key=test-secret' });

  await waitFor(() => posts('/notes').length > 0, 'the post-call note');
  const notes = posts('/notes');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].path, '/api/v2/tickets/11914/notes', 'MILTON #11915 is newer — the brand filter must skip it');
  assert.equal(posts('/api/v2/tickets').length, 0);
});

test('⭐ after-call never invents a product: unknown caller, no stated product → no ticket', async () => {
  await post('/ravan/after-call', {
    // The summary MENTIONS a ceiling fan. The old code called requiredCustomFields({}) and
    // stamped the ticket Ceiling Fans / Trutrtl-Smart-1200 MM / Website / today; we must
    // not stamp it anything at all.
    data: { call_id: 'c5', phone: '9111111111', summary: 'Caller asked about a ceiling fan' },
  }, { auth: '', query: '?key=test-secret' });
  await contactSearched();  // the route has reached the decision point…
  await settle();           // …and nothing follows it.

  assert.equal(posts('/api/v2/tickets').length, 0, 'no product stated → refuse to create rather than fabricate one');
  assert.equal(posts('/notes').length, 0);
});

test('after-call DOES create when Ravan states a product and platform it can file', async () => {
  await post('/ravan/after-call', {
    data: {
      call_id: 'c6', phone: '9111111111', summary: 'Ceiling fan not spinning',
      product: 'ceiling fan', platform: 'Amazon',
    },
  }, { auth: '', query: '?key=test-secret' });
  await waitFor(() => posts('/api/v2/tickets').length > 0, 'the after-call ticket create');

  const created = posts('/api/v2/tickets');
  assert.equal(created.length, 1);
  assert.equal(created[0].body.custom_fields[CF.brand], BRAND);
  assert.equal(created[0].body.custom_fields[CF.productCategory], 'Ceiling Fans');
  assert.equal(created[0].body.custom_fields[CF.platform], 'Amazon');
  assert.ok(created[0].body.tags.includes('trutrtl'));
});

test('⭐ after-call: the 1900 sentinel is EXPLAINED in the description it ships with', async () => {
  // This route hands ticket-fields.js a product and a platform and nothing else, so the
  // ticket it creates carries cf_order_date = 1900-01-01 (ORDER_DATE_NOT_CAPTURED),
  // cf_order_id 'NA' and cf_pin_code 0. register-complaint.js says so in its description;
  // this one used to ship the bare call summary, so ops met a 1900 purchase date with no
  // explanation — on tickets nobody was expecting, because they appear after the call ends.
  await post('/ravan/after-call', {
    data: {
      call_id: 'c9', phone: '9111111111', summary: 'Ceiling fan not spinning',
      product: 'ceiling fan', platform: 'Amazon',
    },
  }, { auth: '', query: '?key=test-secret' });
  await waitFor(() => posts('/api/v2/tickets').length > 0, 'the after-call ticket create');

  const created = posts('/api/v2/tickets')[0].body;
  // The field really does hold the sentinel — the description would otherwise be explaining
  // something that isn't there.
  assert.equal(created.custom_fields[CF.purchaseDate], ORDER_DATE_NOT_CAPTURED);

  const d = created.description;
  assert.ok(d.includes(ORDER_DATE_NOT_CAPTURED),
    'the description must name the sentinel value ops will see in cf_order_date');
  assert.match(d, /not captured/i);
  assert.match(d, /warranty/i, 'warranty runs from the INVOICE date — say so where the decision is made');
  assert.match(d, /order id not provided/i);
  // The warnings lead, as in register-complaint.js: an agent reads the first paragraph and
  // stops, and this is the one that prevents a wrong warranty call.
  assert.ok(d.indexOf('⚠') < d.indexOf('[Post-call summary'),
    'the placeholder warnings must OPEN the description, not trail the transcript');
  // …and the call summary itself is still all there.
  assert.match(d, /Post-call summary/);
  assert.match(d, /Ceiling fan not spinning/);
});

test('after-call: the note path is NOT given the placeholder warnings (it sets no fields)', async () => {
  // Attaching to an existing ticket creates no custom fields, so a "cf_order_date is a
  // sentinel" warning there would describe a field this path never touched.
  await post('/ravan/after-call', {
    data: {
      call_id: 'c9b', phone: '9876543210', summary: 'Following up on the fan',
      product: 'ceiling fan', platform: 'Amazon',
    },
  }, { auth: '', query: '?key=test-secret' });
  await waitFor(() => posts('/notes').length > 0, 'the post-call note');

  const note = posts('/notes')[0].body;
  const text = JSON.stringify(note);
  assert.ok(!text.includes(ORDER_DATE_NOT_CAPTURED), 'no sentinel talk on a ticket we did not create');
  assert.ok(!text.includes('Order ID not provided'));
  assert.equal(posts('/api/v2/tickets').length, 0);
});

test('after-call refuses an unfileable stated product too (no Ceiling Fan fallback)', async () => {
  await post('/ravan/after-call', {
    data: {
      call_id: 'c7', phone: '9111111111', summary: 'Induction not heating',
      product: 'induction', platform: 'Amazon',
    },
  }, { auth: '', query: '?key=test-secret' });
  await contactSearched();
  await settle();
  assert.equal(posts('/api/v2/tickets').length, 0, 'an Induction must never be filed as a Ceiling Fan');
});

test('⭐ after-call refuses "induction stove" as well — same bypass, same route', async () => {
  // after-call shares validateComplaint() with register-complaint, so the bypass reached
  // here too: Ravan stating "induction stove" would have auto-created a GAS STOVE ticket.
  let n = 0;
  for (const product of ['induction stove', 'induction cooktop', 'cooker hob']) {
    calls = []; // per-iteration, so contactSearched() waits for THIS call's decision point
    await post('/ravan/after-call', {
      data: {
        call_id: `c8-${n++}`, phone: '9111111111', summary: `${product} not working`,
        product, platform: 'Amazon',
      },
    }, { auth: '', query: '?key=test-secret' });
    await contactSearched();
    await settle();
    assert.equal(posts('/api/v2/tickets').length, 0, `${product} must never be auto-filed as a Gas Stove`);
  }
});
