// ⭐⭐ THE FIRST REAL CALL FILED TWO TICKETS (#12106 and #12107). This file is that incident,
// turned into assertions.
//
// What happened, from the live transcript and the Ravan logs:
//   call 1 — phone 9876543210 (the agent INVENTED it), platform "Amazon" (also invented)
//            → Ravan: "Request timed out" after 5579ms … and ticket #12106 was created.
//   call 2 — phone 8178490194 (real), platform "Website"
//            → Ravan: "Request timed out" after 5750ms … and ticket #12107 was created.
//   call 3 — identical to call 2 → 604ms → {"complaint_number":"12107"}   (dedup, correct)
//
// Two independent faults, and this file covers both halves that belong to the middleware:
//
//   1. A SUCCESSFUL CREATE TOOK 5.5 SECONDS. The route awaited the private note, the WHAPI
//      send (6s timeout × 2 attempts of its own) and the TEST_AUTO_CLOSE update BEFORE
//      answering — all of it bookkeeping, all of it after the ticket already existed. The
//      client gave up and retried into the dead air. The response now goes out immediately
//      after the create, and the bookkeeping runs behind it.
//   2. A RETRY THAT CHANGED THE PHONE DID NOT DEDUP. That is what turned the timeout into a
//      SECOND TICKET rather than a harmless retry. The key now also tolerates a changed
//      phone when the TELEPHONY layer (caller_id / a call id) says it is the same call —
//      and only then, because a caller's NAME is not an identifier and merging two genuine
//      callers is a far worse failure than a duplicate ticket.
//
// ⚠ Env before any import — lib/config.js reads it at import time and `dotenv/config` never
// overrides an already-set variable, so the operator's real .env cannot leak in. WHAPI is
// deliberately ENABLED here (pointed at a stub host): its 6s×2 budget was the single
// biggest contributor to the 5.5s, so a test that leaves it off cannot see the defect.
// TEST_AUTO_CLOSE is ON for the same reason — the close PUT was also on the response path.
process.env.RAVAN_SHARED_SECRET = 'test-secret';
process.env.FRESHDESK_DOMAIN = 'stub.freshdesk.com';
process.env.FRESHDESK_API_KEY = 'stub-key';
process.env.WHAPI_ENABLED = 'true';
process.env.WHAPI_TOKEN = 'stub-token';
process.env.WHAPI_BASE_URL = 'http://whapi.stub';
process.env.TEST_AUTO_CLOSE = 'true';
process.env.COMPLAINT_ID_MODE = 'TICKET_ID';
process.env.IDEMPOTENCY_WINDOW_MS = '300000';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../../src/app.js');
const { drainBackgroundWork } = await import('../../src/routes/register-complaint.js');

// ── Freshdesk + WHAPI stub, with controllable latency ────────────────────────

let calls = [];
// `calls` records a request when it is ISSUED. `finished` records it when it COMPLETES —
// the difference is the whole fix: the bookkeeping is issued immediately after the create
// and finishes long after the caller has been answered.
let finished = [];
let realFetch;
let nextTicketId = 20001;
// How long the BOOKKEEPING calls take. 0 for most tests; the latency test raises it so the
// response can be proven not to be waiting on them.
let slowMs = 0;
// Per-call failure switches: background work must never be able to reach the caller.
let failBookkeeping = false;

const posts = (path) => calls.filter((c) => c.method === 'POST' && c.path.endsWith(path));
const creates = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v2/tickets');
const notes = () => posts('/notes');
const closes = () => calls.filter((c) => c.method === 'PUT' && /^\/api\/v2\/tickets\/\d+$/.test(c.path));
const whapiSends = () => calls.filter((c) => c.host === 'whapi.stub');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    calls.push({ method, host: u.host, path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });

    // WHAPI — the send that owned ~6 of the 5.5 seconds when it was on the response path.
    if (u.host === 'whapi.stub') {
      if (slowMs) await sleep(slowMs);
      finished.push('whapi');
      return failBookkeeping ? jsonRes(500, { error: 'whapi down' }) : jsonRes(200, { sent: true });
    }

    assert.equal(u.host, 'stub.freshdesk.com', `test tried to reach ${u.host}`);

    // The create is the ONLY thing the caller may wait on — kept fast on purpose.
    if (method === 'POST' && u.pathname === '/api/v2/tickets') {
      finished.push('create');
      return jsonRes(201, { id: nextTicketId++ });
    }
    // Everything below is bookkeeping.
    if (method === 'POST' && /\/notes$/.test(u.pathname)) {
      if (slowMs) await sleep(slowMs);
      finished.push('note');
      return failBookkeeping ? jsonRes(500, { error: 'notes down' }) : jsonRes(201, { id: 1 });
    }
    if (method === 'PUT' && /^\/api\/v2\/tickets\/\d+$/.test(u.pathname)) {
      if (slowMs) await sleep(slowMs);
      finished.push('close');
      return failBookkeeping ? jsonRes(500, { error: 'update down' }) : jsonRes(200, {});
    }
    throw new Error(`unstubbed ${method} ${u.host}${u.pathname}`);
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(async () => {
  await drainBackgroundWork();
  calls = [];
  finished = [];
  slowMs = 0;
  failBookkeeping = false;
});
after(async () => { await drainBackgroundWork(); });

// ── Harness ──────────────────────────────────────────────────────────────────

const server = createApp().listen(0);
after(() => server.close());

async function register(body) {
  const res = await realFetch(`http://127.0.0.1:${server.address().port}/freshdesk/register-complaint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The complaint from the real call, minus the fields each test varies.
const CALL = {
  name: 'Ankit Verma',
  product: 'ceiling fan',
  issue_description: 'The fan makes a loud noise and wobbles',
  city: 'Hyderabad', state: 'Telangana', pincode: '500001',
};

let n = 0;
const freshPhone = () => `98180000${String(10 + (n++)).slice(-2)}`;

// ── ⭐ FIX 1: the response is not waiting on the bookkeeping ──────────────────

test('⭐ a successful registration answers in ONE Freshdesk round-trip — the bookkeeping is not on the path', async () => {
  // Warm the server first, with every stub instant. The very first request into a fresh
  // express app pays route compilation and JIT, and this is a timing test — measuring that
  // once-per-process cost would tell us nothing about the ordering under test, and makes the
  // assertion flaky when `node --test` runs the files in parallel.
  await register({ ...CALL, phone_number: freshPhone(), platform: 'Amazon', issue_description: 'warm up' });
  await drainBackgroundWork();
  calls = [];
  finished = [];

  // Each bookkeeping call is made to take 600ms. On the old ordering the caller waited for
  // all of them (note + WhatsApp + note + close ≈ 2.4s here, 5.5s on the real desk).
  slowMs = 600;

  const t0 = Date.now();
  const r = await register({ ...CALL, phone_number: freshPhone(), platform: 'Amazon' });
  const elapsed = Date.now() - t0;

  assert.equal(r.status, 200);
  assert.match(String(r.body.complaint_number), /^\d+$/, 'the caller gets a real complaint number');

  // ⭐ THE STRUCTURAL ASSERTION, which does not depend on how fast the machine is: at the
  // moment the caller was answered, the only request that had COMPLETED was the create.
  // (The note has already been ISSUED by then — that is correct and is the point: it is in
  // flight, and nobody is waiting for it.)
  assert.equal(creates().length, 1, 'exactly one create');
  assert.deepEqual(finished, ['create'],
    'the caller was answered before any bookkeeping finished — nothing else may be awaited');

  // …and the timing assertion the incident is actually about. Ravan gave up at ~5.5s; the
  // target is well under 1.5s, and with the bookkeeping off the path the only cost left is
  // the create itself. 600ms of bookkeeping is pending right now, so a threshold below that
  // proves the response did not wait for even one step of it.
  assert.ok(elapsed < 500, `responded in ${elapsed}ms — the bookkeeping is back on the response path`);

  // Nothing was dropped: every step still runs, just afterwards. The comparison is the
  // headline: the caller waited for `elapsed`, the work they used to wait for takes this.
  const t1 = Date.now();
  await drainBackgroundWork();
  const backgroundMs = Date.now() - t1;
  assert.ok(
    elapsed < backgroundMs,
    `the caller waited ${elapsed}ms; the bookkeeping the old ordering made them wait for took `
    + `a further ${backgroundMs}ms`,
  );
  assert.ok(notes().some((c) => /Awaiting invoice \+ issue video on WhatsApp/.test(c.body?.body || '')),
    'the awaiting-documents note must still be written');
  assert.equal(whapiSends().length, 1, 'the document-request WhatsApp must still go out');
  assert.equal(closes().length, 1, 'TEST_AUTO_CLOSE must still close the test ticket');
  assert.equal(creates().length, 1, 'and still exactly one ticket');
});

test('⭐ bookkeeping that FAILS entirely never reaches the caller', async () => {
  // Every background step 500s. The ticket exists and the number Tara read out is already
  // true, so this must be invisible on the wire — and it must not take the process down
  // either (an unhandled rejection in fire-and-forget work would kill every call in flight).
  failBookkeeping = true;
  const r = await register({ ...CALL, phone_number: freshPhone(), platform: 'Flipkart' });

  assert.equal(r.status, 200, 'never a non-200 to the voice agent');
  assert.equal(r.body.error, undefined, 'a failed note is not a failed registration');
  assert.match(String(r.body.complaint_number), /^\d+$/);

  await drainBackgroundWork(); // must settle, not reject
  assert.equal(creates().length, 1);

  // The route still works for the next caller.
  const next = await register({ ...CALL, phone_number: freshPhone(), platform: 'Flipkart' });
  assert.match(String(next.body.complaint_number), /^\d+$/);
});

// ── ⭐ FIX 2: a retry after a client-side timeout must never double-file ──────

test('⭐ a retry arriving DURING the background work is deduped — the slot is reserved before the response', async () => {
  // This is the regression that makes fix 1 safe. Moving the bookkeeping off the response
  // path would widen the duplicate window if the dedup entry moved with it: the retry would
  // land while the notes were still being written, find nothing, and create ticket two.
  slowMs = 400;
  const phone = freshPhone();
  const payload = { ...CALL, phone_number: phone, platform: 'Amazon' };

  const first = await register(payload);
  assert.match(String(first.body.complaint_number), /^\d+$/);
  // Background work is still in flight right now — that is the whole point of the timing.
  assert.ok(!finished.includes('close'), 'precondition: the bookkeeping has not finished yet');

  const retry = await register(payload);
  assert.equal(retry.body.complaint_number, first.body.complaint_number, 'same number, not a new one');
  assert.equal(creates().length, 1, 'a retry during the bookkeeping must NOT create a second ticket');

  await drainBackgroundWork();
  assert.equal(creates().length, 1);
});

test('⭐ concurrent identical registrations join one create (the in-flight slot, both keys)', async () => {
  slowMs = 200;
  const payload = { ...CALL, phone_number: freshPhone(), platform: 'Amazon', caller_id: '9812300099' };
  const [a, b, c] = await Promise.all([register(payload), register(payload), register(payload)]);
  assert.equal(a.body.complaint_number, b.body.complaint_number);
  assert.equal(b.body.complaint_number, c.body.complaint_number);
  assert.equal(creates().length, 1, 'three simultaneous retries, one ticket');
});

test('⭐ THE #12106/#12107 CASE: a retry that CORRECTED the phone number does not double-file', async () => {
  // The real sequence. The agent invented 9876543210 / "Amazon" on the first attempt, then
  // sent the true 8178490194 / "Website" on the retry, so the two attempts keyed differently
  // and both created a ticket. The telephony caller_id is identical across both — it comes
  // from the switch, not from the model, which is exactly why it can be trusted here.
  const ani = '8178490194';
  const first = await register({
    ...CALL, phone_number: '9876543210', platform: 'Amazon', model: '3-in-1', caller_id: ani,
  });
  assert.match(String(first.body.complaint_number), /^\d+$/);

  const retry = await register({
    ...CALL, phone_number: '8178490194', platform: 'Website', model: 'premium', caller_id: ani,
  });
  assert.equal(
    retry.body.complaint_number, first.body.complaint_number,
    'the corrected retry must be recognised as the same complaint',
  );
  assert.equal(creates().length, 1, 'ONE ticket — this is the duplicate the live call filed');
});

test('⭐ the same tolerance works on a call/session id when the platform sends one', async () => {
  const call_id = 'ravan-session-77';
  const first = await register({ ...CALL, phone_number: freshPhone(), platform: 'Amazon', call_id });
  const retry = await register({ ...CALL, phone_number: freshPhone(), platform: 'Zepto', call_id });
  assert.equal(retry.body.complaint_number, first.body.complaint_number);
  assert.equal(creates().length, 1);
});

test('⛔ two DIFFERENT callers are never merged, however similar the complaint', async () => {
  // The rejected design, pinned. Keying on name + product + issue and letting the phone vary
  // would collapse these two into one ticket: same name, same category, same issue text,
  // seconds apart. The second caller would be read back a complaint number for a ticket that
  // is not theirs — and, because the names match, a later status call would pass the identity
  // gate on the FIRST caller's ticket and read them someone else's case.
  const a = await register({ ...CALL, phone_number: '9812300001', platform: 'Amazon' });
  const b = await register({ ...CALL, phone_number: '9812300002', platform: 'Amazon' });
  assert.notEqual(b.body.complaint_number, a.body.complaint_number, 'two callers, two complaints');
  assert.equal(creates().length, 2);

  // Even with a caller_id on each — two different lines are two different people.
  calls = [];
  const c = await register({ ...CALL, phone_number: '9812300003', platform: 'Amazon', caller_id: '9812300003' });
  const d = await register({ ...CALL, phone_number: '9812300004', platform: 'Amazon', caller_id: '9812300004' });
  assert.notEqual(d.body.complaint_number, c.body.complaint_number);
  assert.equal(creates().length, 2);
});

test('⭐ a genuine SECOND complaint on the same call still files (the issue text stays in every key)', async () => {
  const ani = '9812300055';
  const phone = freshPhone();
  const first = await register({
    ...CALL, phone_number: phone, platform: 'Amazon', caller_id: ani,
  });
  // Same caller, same line, same product category — a DIFFERENT fault. Two broken products
  // must never be answered with one complaint number, whatever the dedup key tolerates.
  const second = await register({
    ...CALL, phone_number: phone, platform: 'Amazon', caller_id: ani,
    issue_description: 'The second fan I bought does not switch on at all',
  });
  assert.notEqual(second.body.complaint_number, first.body.complaint_number);
  assert.equal(creates().length, 2, 'a second, different complaint must be filed');
});

test('a withheld or unusable caller_id changes nothing — phone-keyed, exactly as before', async () => {
  // 'anonymous'/'private'/short codes identify nobody, so they must not be allowed to merge
  // anybody. Two callers with no usable ANI still get two tickets.
  const a = await register({ ...CALL, phone_number: '9812300011', platform: 'Amazon', caller_id: 'anonymous' });
  const b = await register({ ...CALL, phone_number: '9812300012', platform: 'Amazon', caller_id: 'private' });
  assert.notEqual(b.body.complaint_number, a.body.complaint_number);
  assert.equal(creates().length, 2);
});

// ── The contract the voice agent depends on, unchanged by any of the above ────

test('the honest-failure shapes still come back on the fast path', async () => {
  const bad = await register({ ...CALL, phone_number: '98765', platform: 'Amazon' });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.reason, 'invalid_phone');
  assert.ok(bad.body.spoken_hint);
  assert.equal(bad.body.complaint_number, undefined);
  assert.equal(calls.length, 0, 'nothing may be written for a refused complaint');

  const unfilable = await register({ ...CALL, phone_number: freshPhone(), platform: 'Amazon', product: 'induction' });
  assert.equal(unfilable.body.reason, 'category_unavailable');
  assert.equal(creates().length, 0);

  const missing = await register({ name: 'Ankit' });
  assert.equal(missing.body.reason, 'missing_required');
  assert.ok(missing.body.missing.includes('phone_number'));
});
