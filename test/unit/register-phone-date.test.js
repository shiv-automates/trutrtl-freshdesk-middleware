// M-2 (phone validation + caller_id) and the route half of M-7 (order-date normalisation +
// the placeholder warnings moving to the top of the description), tested against a STUBBED
// Freshdesk. globalThis.fetch is intercepted for the whole file, so nothing here touches the
// network and no ticket is ever created on the live shared desk (digicart.freshdesk.com).
//
// What these tests are actually protecting:
//   • A misheard number used to be filed verbatim. toStorage() takes the LAST TEN DIGITS of
//     anything, so an eight-digit fragment or an ASR hallucination became a confident
//     "+91…" on a real ticket, and the document-request WhatsApp went to a stranger.
//   • A caller ringing from a different line looked identical to a misheard number, and ops
//     had no way to tell which had happened.
//   • The caller's free-text purchase date was thrown away by requiredCustomFields() and
//     replaced with today — on the one field a warranty decision is made from.
//   • The warnings that say "this value is a placeholder, do not judge warranty by it" sat
//     BELOW the issue text, where an agent who has already read the complaint stops.
//
// ⚠ Env is set BEFORE importing anything — lib/config.js reads it at import time, and
// `dotenv/config` never overrides a variable that is already set, so the operator's real
// .env cannot leak into this run. WHAPI and TEST_AUTO_CLOSE are forced OFF: the first would
// send a real WhatsApp, the second would close and re-tag every ticket asserted below.
process.env.RAVAN_SHARED_SECRET = 'test-secret';
process.env.FRESHDESK_DOMAIN = 'stub.freshdesk.com';
process.env.FRESHDESK_API_KEY = 'stub-key';
process.env.WHAPI_ENABLED = 'false';
process.env.TEST_AUTO_CLOSE = 'false';
process.env.COMPLAINT_ID_MODE = 'TICKET_ID';
process.env.IDEMPOTENCY_WINDOW_MS = '300000';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { config } = await import('../../src/lib/config.js');
const { createApp } = await import('../../src/app.js');
// ⭐ 2026-07-20. The notes and the WhatsApp send now run AFTER the response (they are what
// made a successful create take 5.5s and Ravan retry it into a duplicate ticket), so a note
// assertion that runs the instant register() resolves is racing the work it is checking.
// drainBackgroundWork() awaits exactly that work — no sleeps, no flake.
const { drainBackgroundWork } = await import('../../src/routes/register-complaint.js');

const CF = config.cf;

// ── Freshdesk stub ───────────────────────────────────────────────────────────

let calls = [];
let realFetch;
const posts = (path) => calls.filter((c) => c.method === 'POST' && c.path.endsWith(path));
const created = () => posts('/api/v2/tickets').map((c) => c.body);
const notes = () => posts('/notes').map((c) => c.body);

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
    if (method === 'POST' && u.pathname === '/api/v2/tickets') return jsonRes(201, { id: 12345 });
    if (method === 'POST' && /\/notes$/.test(u.pathname)) return jsonRes(201, { id: 1 });
    throw new Error(`unstubbed ${method} ${u.pathname}`);
  };
});
after(() => { globalThis.fetch = realFetch; });
// Drain first: a previous test's background bookkeeping must not land in this test's log.
beforeEach(async () => { await drainBackgroundWork(); calls = []; });

// ── Harness ──────────────────────────────────────────────────────────────────

const server = createApp().listen(0);
const port = () => server.address().port;
after(() => server.close());

async function register(body, { auth = 'test-secret' } = {}) {
  const res = await realFetch(`http://127.0.0.1:${port()}/freshdesk/register-complaint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

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

// Each test needs its own phone: the dedup key is phone + category + issue, so reusing one
// would hand the second test the first test's ticket id and assert nothing.
let n = 0;
const freshPhone = () => `98765432${String(10 + (n++)).slice(-2)}`;

// ── ⭐ M-2: the number is validated before anything is written ────────────────

test('⭐ a number that is not a valid Indian mobile is refused — nothing is written', async () => {
  for (const phone of [
    '98765',            // truncated — toStorage() would have filed "+9198765"
    '987654321',        // nine digits, one short: the classic ASR drop
    '12345678901',      // last ten digits start with 2 — not a mobile series
    '5876543210',       // 5-series: not an Indian mobile
    '0000000000',
    'nine eight seven', // ASR handed us words, not digits
  ]) {
    calls = [];
    const r = await register({ ...VALID, phone_number: phone });
    assert.equal(r.status, 200, `${phone}: never a non-200 to the voice agent`);
    assert.equal(r.body.error, true, `${phone}: must be an honest failure`);
    assert.equal(r.body.reason, 'invalid_phone', `${phone}: reason`);
    assert.ok(r.body.spoken_hint, `${phone}: Tara needs something safe to say`);
    assert.equal(r.body.complaint_number, undefined, 'Tara must have no number to read back');
    assert.equal(calls.length, 0, `${phone}: the check must run BEFORE any Freshdesk write`);
  }
});

test('the invalid_phone hint is a re-ask, and it is safe to say on a recorded line', async () => {
  const r = await register({ ...VALID, phone_number: '98765' });
  assert.equal(
    r.body.spoken_hint,
    'Let me just take that number again — could you say it digit by digit?',
  );
  // No blame, no jargon, no invented commitment: the three ways this line could hurt.
  assert.ok(!/wrong|invalid|incorrect|error|system|field/i.test(r.body.spoken_hint));
});

test('⭐ invalid_phone is RECOVERABLE — the corrected number files immediately', async () => {
  const phone = freshPhone();
  const bad = await register({ ...VALID, phone_number: phone.slice(0, 8) });
  assert.equal(bad.body.reason, 'invalid_phone');
  assert.equal(created().length, 0);

  // Tara re-asks, the caller says it digit by digit, and the SAME complaint files. A
  // terminal classification here would have cost the customer their complaint.
  calls = [];
  const good = await register({ ...VALID, phone_number: phone });
  assert.equal(good.body.complaint_number, '12345');
  assert.equal(created().length, 1);
  assert.equal(created()[0].phone, `+91${phone}`);
});

test('a valid number in any spoken/typed shape still files', async () => {
  for (const phone of ['+91 98765 43299', '098765-43298', '919876543297']) {
    calls = [];
    const r = await register({ ...VALID, phone_number: phone, issue_description: `fan noise ${phone}` });
    assert.equal(r.body.complaint_number, '12345', `${phone}: should have filed`);
    assert.match(created()[0].phone, /^\+91[6-9]\d{9}$/);
  }
});

// ── ⭐ M-2: caller_id (telephony ANI) ─────────────────────────────────────────

test('⭐ a caller_id that disagrees still FILES, with both numbers and a verify note', async () => {
  const stated = freshPhone();
  const r = await register({ ...VALID, phone_number: stated, caller_id: '+919000000123' });

  // The complaint is not held hostage to the disagreement — people call from other lines.
  assert.equal(r.body.complaint_number, '12345');
  assert.equal(created().length, 1);

  await drainBackgroundWork(); // the notes are written after the caller has been answered
  const note = notes().find((b) => /different number/.test(b.body || ''));
  assert.ok(note, 'ops must get a private note about the disagreement');
  assert.equal(note.private, true, 'the note must never be customer-visible');
  assert.match(note.body, /Caller stated a different number from the one they called from — verify/);
  assert.match(note.body, new RegExp(`\\+91${stated}`), 'the stated number belongs in the note');
  assert.match(note.body, /\+919000000123/, 'so does the number they called from');

  // Both numbers on the ticket itself, not only in the activity feed.
  const d = created()[0].description;
  assert.match(d, new RegExp(`\\+91${stated}`));
  assert.match(d, /\+919000000123/);
});

test('a caller_id that AGREES (different formatting) raises nothing', async () => {
  const stated = freshPhone();
  const r = await register({ ...VALID, phone_number: stated, caller_id: `+91 ${stated}` });
  assert.equal(r.body.complaint_number, '12345');
  await drainBackgroundWork(); // assert on the FULL note set, not on a half-written one
  assert.equal(notes().filter((b) => /different number/.test(b.body || '')).length, 0,
    'a formatting difference is not a disagreement');
  assert.ok(!/Numbers disagree/.test(created()[0].description));
});

test('an unusable caller_id is ignored rather than flagged as a disagreement', async () => {
  // Withheld/blocked ANI and short codes carry no subscriber number. Flagging those would
  // put a "verify" note on ordinary tickets until ops stopped reading the note at all.
  for (const caller_id of ['anonymous', 'private', '', undefined, '1800']) {
    await drainBackgroundWork();
    calls = [];
    const stated = freshPhone();
    const r = await register({ ...VALID, phone_number: stated, caller_id });
    assert.equal(r.body.complaint_number, '12345');
    await drainBackgroundWork();
    assert.equal(notes().filter((b) => /different number/.test(b.body || '')).length, 0,
      `caller_id ${JSON.stringify(caller_id)} must not raise a mismatch`);
  }
});

test('a caller_id disagreement never diverts the ticket phone or the WhatsApp target', async () => {
  const stated = freshPhone();
  await register({ ...VALID, phone_number: stated, caller_id: '9000000124' });
  // The number the customer ASKED to be reached on is the one we file. The ANI is evidence
  // for ops, not a silent override — quietly switching would be the same defect in reverse.
  assert.equal(created()[0].phone, `+91${stated}`);
});

// ── ⭐ M-7 (route half): the order date, and where the warnings sit ───────────

test('an ISO purchase date is filed exactly, in the byte-for-byte subject template', async () => {
  const r = await register({ ...VALID, phone_number: freshPhone(), purchase_date: '2026-05-01' });
  assert.equal(r.body.complaint_number, '12345');
  const t = created()[0];
  // KEEP BYTE-FOR-BYTE — digiCART's intake automation parses this subject, space before the
  // comma included. M-7 changed the VALUE in it, never the template.
  assert.match(t.subject, /^Complaint Date- \d{2}\.\d{2}\.\d{4}, Order Date: 01-05-2026 , Order ID- AMZ-123$/);
  assert.match(t.description, /^Purchase date: 2026-05-01$/m);
  assert.ok(!/APPROXIMATE/.test(t.description), 'an exact date must not be hedged');
});

test('⭐ free-text dates are resolved, not passed through into the subject', async () => {
  const r = await register({ ...VALID, phone_number: freshPhone(), purchase_date: '26 May' });
  const t = created()[0];
  assert.match(t.subject, /Order Date: 26-05-\d{4} ,/, 'the caller\'s words must become a real date');
  assert.ok(!/26 May/.test(t.subject), 'raw speech must never reach the parsed subject field');
  assert.match(t.custom_fields[CF.purchaseDate], /^\d{4}-05-26$/);
});

test('⭐ a relative date resolves against the call time rather than defaulting to today', async () => {
  const r = await register({ ...VALID, phone_number: freshPhone(), purchase_date: 'two months ago' });
  const t = created()[0];
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  // The whole defect: "two months ago" used to be discarded and the field stamped TODAY,
  // which makes a two-month-old product look bought this morning on the field warranty is
  // assessed from.
  assert.notEqual(t.custom_fields[CF.purchaseDate], today);
  assert.match(t.subject, /Order Date: \d{2}-\d{2}-\d{4} ,/);
  assert.ok(!/two months ago/.test(t.subject));
});

test('⭐ an APPROXIMATE date carries its warning THROUGH the route, in the caller\'s words', async () => {
  // REGRESSION (precision laundering). order-date.test.js proves fieldFallbacks() raises the
  // APPROXIMATE warning; that is a UNIT test, and the route was quietly defeating it. The
  // route pre-resolved the date to ISO before handing it to ticket-fields.js, and
  // fieldFallbacks() re-normalises whatever it is given to decide the precision — an ISO
  // string can only read back as 'exact'. So the warning that exists to stop a warranty
  // decision being made off an estimate never rendered on a real ticket, while every unit
  // test still passed. Only 'unknown' survived the round trip (null re-reads as null), which
  // is what made this look covered. Assert it at the ROUTE, on the payload Freshdesk gets.
  for (const said of ['two months ago', '26 May', 'last January']) {
    calls = [];
    const r = await register({
      ...VALID, phone_number: freshPhone(), purchase_date: said, issue_description: `approx ${said}`,
    });
    assert.equal(r.body.complaint_number, '12345', `${said}: still files`);
    const d = created()[0].description;
    assert.match(d, /⚠ Order date is APPROXIMATE/, `${said}: the warning must reach the ticket`);
    // ...at the TOP, where M-7 put it, not only in the body line further down.
    assert.ok(d.split('\n')[0].startsWith('⚠ Order date is APPROXIMATE'),
      `${said}: the approximate warning must OPEN the description, got: ${d.split('\n')[0]}`);
    // The caller's own words, not our resolved ISO echoed back at ops.
    assert.ok(d.includes(`the caller said "${said}"`), `${said}: quote the caller, not the ISO`);
  }
});

test('⭐ a date we could not understand says so, and never becomes a confident value', async () => {
  const said = 'I really do not remember at all';
  const r = await register({ ...VALID, phone_number: freshPhone(), purchase_date: said });
  const t = created()[0];
  assert.equal(r.body.complaint_number, '12345', 'an unknown date must not cost the complaint');
  // 'NA' is exactly what an absent date has always rendered as — no invented date.
  assert.match(t.subject, /Order Date: NA ,/);
  assert.match(t.description, /Purchase date: NOT UNDERSTOOD/);
  assert.ok(t.description.includes(said), 'what the caller actually said stays on the ticket');
});

test('⭐ the placeholder warnings open the description, above the issue text', async () => {
  // No order id and no location → fieldFallbacks() has something to warn about.
  const r = await register({
    ...VALID, phone_number: freshPhone(), order_id: '', city: '', state: '', pincode: '',
  });
  const d = created()[0].description;
  const lines = d.split('\n');

  assert.ok(lines[0].startsWith('⚠'), `the first line must be a warning, got: ${lines[0]}`);
  const lastWarning = lines.map((l, i) => (l.startsWith('⚠') ? i : -1)).filter((i) => i >= 0).pop();
  const issueLine = lines.findIndex((l) => l.startsWith('Issue:'));
  assert.ok(issueLine > 0, 'the issue text must still be on the ticket');
  assert.ok(lastWarning < issueLine,
    'every placeholder warning must sit ABOVE the issue text — below it, nobody scrolls');
  // Everything the old layout guaranteed is still there.
  assert.match(d, new RegExp(`^Brand: ${config.cf.brandValue}$`, 'm'));
  assert.match(d, /^Issue: It stopped spinning after two weeks$/m);
  assert.match(d, /Invoice \+ issue video to follow on WhatsApp\.$/);
});

test('the mismatch warning leads the description too, above the issue text', async () => {
  const stated = freshPhone();
  await register({ ...VALID, phone_number: stated, caller_id: '9000000125' });
  const lines = created()[0].description.split('\n');
  const warn = lines.findIndex((l) => /Numbers disagree/.test(l));
  const issueLine = lines.findIndex((l) => l.startsWith('Issue:'));
  assert.ok(warn >= 0 && warn < issueLine, 'ops reads the top of the description');
});

// ── Regressions the two changes must not have broken ─────────────────────────

test('an unfileable product is still refused for the RIGHT reason once the number is valid', async () => {
  // The two gates must not shadow each other: a good number with an unfileable product is
  // still category_unavailable, and Tara still takes a callback rather than re-asking for
  // a number that was never the problem.
  const r = await register({ ...VALID, phone_number: freshPhone(), product: 'induction' });
  assert.equal(r.body.reason, 'category_unavailable');
  assert.equal(created().length, 0);
});

test('missing_required still wins over invalid_phone when the number is absent', async () => {
  const r = await register({ ...VALID, phone_number: '' });
  assert.equal(r.body.reason, 'missing_required');
  assert.ok(r.body.missing.includes('phone_number'));
  assert.equal(calls.length, 0);
});

test('the awaiting-documents note and the tag set are untouched', async () => {
  const r = await register({ ...VALID, phone_number: freshPhone() });
  const t = created()[0];
  assert.deepEqual([...t.tags].sort(), ['trutrtl', 'voice_agent', 'warranty']);

  // ⭐ The note moved OFF the response path (it is bookkeeping, and awaiting it is what made
  // a successful create take 5.5s), but it must still be written — the customer's invoice
  // and issue video are tracked from it. Answer first, then write it.
  assert.equal(r.body.complaint_number, '12345');
  await drainBackgroundWork();
  assert.ok(notes().some((b) => /Awaiting invoice \+ issue video on WhatsApp/.test(b.body || '')),
    'the pending-documents note must still be written, just no longer before the response');
});

test('register-complaint still requires the Bearer token', async () => {
  const r = await register(VALID, { auth: '' });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});
