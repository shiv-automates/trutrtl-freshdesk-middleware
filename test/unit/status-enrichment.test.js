// M-4 + M-5 — status enrichment and the closure reason (client defects 5, 8, 17, 19, 20).
//
// What these lock down: the queue is the real outcome on this desk, and until now the
// middleware never read it — so "a replacement was couriered to you" and "we closed it
// because you stopped replying" came out of Tara's mouth as the same sentence, and a
// 32-day-old breached complaint answered exactly like a 2-day-old one.
//
// Two rules here are guardrails, not features, and a failure on either is a live
// incident: NOTHING added by M-4 may appear before the identity gate passes, and
// closureReason() must never emit raw internal note text.
//
// (Kept in its own file so the other workstreams' edits to helpers.test.js cannot
//  collide with it — same reasoning as brand-gate.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../src/lib/config.js';
import { formatStatus, safeLatestNote } from '../../src/lib/ravan.js';
import {
  resolveQueue, closureReason, isSlaBreached, nextStep,
  GROUP_SPEECH, SLA_BREACH_NEXT_STEP, SLA_OPEN_DAYS,
} from '../../src/lib/status-map.js';
import { formatDateSpoken } from '../../src/lib/time-since.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const ticketOf = (overrides = {}, cfOverrides = {}) => ({
  id: 11914,
  status: 3,
  group_id: 81000089580,
  created_at: daysAgo(4),
  custom_fields: {
    [config.cf.brand]: config.cf.brandValue,
    [config.cf.product]: 'Ceiling Fan',
    [config.cf.groupCustom]: 'with Technicians',
    ...cfOverrides,
  },
  requester: { name: 'Priya Sharma' },
  conversations: [],
  ...overrides,
});

const asPriya = (t) => formatStatus(t, { callerStatedName: 'Priya' });

// ── A. THE QUEUE VOCABULARY (defect 5) ───────────────────────────────────────

test('resolveQueue: the client\'s own F/G glossary, however ops typed it', () => {
  // Case and punctuation vary in the wild; the create path writes 'WITH DIGICART'
  // while the group itself reads 'with digiCART'.
  assert.equal(resolveQueue('with digiCART').key, 'with_digicart');
  assert.equal(resolveQueue('WITH DIGICART').key, 'with_digicart');
  assert.equal(resolveQueue(config.groupCustomValue).key, 'with_digicart');
  assert.equal(resolveQueue('Rapid Era').key, 'rapid_era');
  assert.equal(resolveQueue('with 247').key, 'with_247');
  assert.equal(resolveQueue('with Technicians').key, 'with_technicians');
  assert.equal(resolveQueue('No Technician Found').key, 'no_technician_found');
  assert.equal(resolveQueue('No Tech Found').key, 'no_technician_found');
  assert.equal(resolveQueue('Courier').key, 'courier');
  assert.equal(resolveQueue('No Comm from Customer').key, 'no_comm_customer');
  assert.equal(resolveQueue('No Comm Cust').key, 'no_comm_customer');
  assert.equal(resolveQueue('with Customer').key, 'with_customer');

  // Both service-centre queues mean the SAME thing to the customer (client's G column).
  assert.equal(resolveQueue('Rapid Era').spoken, resolveQueue('with 247').spoken);
  assert.match(resolveQueue('Courier').spoken, /courier/i); // C3: courier queue no longer asserts 'replacement' (defect #14)
  assert.match(resolveQueue('with Technicians').spoken, /technician/i);

  // group_id fallback: cf_group_custom is a MIRROR dropdown and ops re-queue by moving
  // the group without always re-picking it.
  assert.equal(resolveQueue(null, 81000089580).key, 'with_digicart');
  assert.equal(resolveQueue('', 81000089582).key, 'with_247');
  assert.equal(resolveQueue(undefined, '81000089594').key, 'warranty');
  // cf_group_custom wins when both are present.
  assert.equal(resolveQueue('Courier', 81000089580).key, 'courier');
});

test('⭐ resolveQueue: a queue we have no CLIENT-GIVEN meaning for is never spoken', () => {
  // Warranty and 'with Factory' are real live queues the F/G glossary does not define.
  // They get a key (so logs are useful) and NO phrase — Tara falls back to the status
  // label instead of inventing a meaning on a recorded line.
  assert.equal(resolveQueue('Warranty').key, 'warranty');
  assert.equal(resolveQueue('Warranty').spoken, null);
  assert.equal(resolveQueue('with Factory').spoken, null);

  // Unrecognised entirely — including another brand's ops queues — resolves to nothing.
  for (const q of ['MILTON HV', 'BAD REVIEWS', 'something new ops invented', '', null, undefined]) {
    assert.equal(resolveQueue(q).spoken, null, `${q} must not be speakable`);
  }
  assert.equal(resolveQueue(null, 999999).key, null); // unknown group id
  assert.equal(resolveQueue('  ').raw, null);

  // Every phrase we DO have is customer-facing English, not ops shorthand.
  for (const [key, phrase] of Object.entries(GROUP_SPEECH)) {
    assert.ok(phrase.length > 15, `${key} phrase is too terse to be a sentence`);
    assert.doesNotMatch(phrase, /digicart|247|rapid era/i, `${key} leaks ops vocabulary`);
  }
});

test('formatStatus: queue_spoken is the sayable form — and the ONLY queue form on the wire', () => {
  const out = asPriya(ticketOf());
  assert.match(out.queue_spoken, /technician/i);      // the only sayable form
  assert.equal(out.queue, undefined, 'the raw ops queue string must not cross the wire');

  // A queue with no client-given meaning yields NO queue field of any kind.
  const warranty = asPriya(ticketOf({}, { [config.cf.groupCustom]: 'Warranty' }));
  assert.equal(warranty.queue, undefined);
  assert.equal(warranty.queue_spoken, undefined);
});

test('⭐ NO raw ops vocabulary reaches the voice agent, on ANY queue (defect: `queue` on the wire)', () => {
  // This response is read by an LLM under a heading that says "Tara reads this aloud", so
  // a raw queue string in it was one retrieval-miss (KB §6.2 B is RAG) away from "your
  // ticket is with Rapid Era" being said to a customer. It is now excluded by CODE, which
  // is the same standard the identity gate is held to. If this test fails, the fix has
  // been reverted — do not "fix" it by editing the forbidden list.
  const FORBIDDEN = [
    'with digiCART', 'digiCART', 'Rapid Era', 'No Comm from Customer', 'No Tech Found',
    'No Technician Found', 'with 247', 'with Technicians', 'with Factory', 'with Customer',
  ];

  // Every queue the desk actually uses, spoken and unspoken, open and closed.
  const QUEUES = [
    'with digiCART', 'WITH DIGICART', 'Rapid Era', 'with 247', 'with Technicians',
    'No Technician Found', 'No Tech Found', 'Courier', 'No Comm from Customer',
    'No Comm Cust', 'with Customer', 'Warranty', 'with Factory', 'MILTON HV', '', null,
  ];

  for (const q of QUEUES) {
    for (const status of [2, 3, 4, 5]) {
      const out = asPriya(ticketOf({ status }, { [config.cf.groupCustom]: q }));
      assert.equal(out.found, true);
      assert.equal(out.name_matches, true, 'this caller passes the gate — a full response');
      const blob = JSON.stringify(out);
      for (const raw of FORBIDDEN) {
        assert.ok(!blob.includes(raw), `raw ops vocabulary "${raw}" leaked for queue ${q} / status ${status}: ${blob}`);
      }
      assert.equal(out.queue, undefined, `queue must be absent (queue=${q})`);
    }
  }

  // …and the group_id fallback path cannot smuggle one in either.
  for (const groupId of [81000089580, 81000089582, 81000089594, 999999]) {
    const out = asPriya(ticketOf({ group_id: groupId }, { [config.cf.groupCustom]: undefined }));
    assert.equal(out.queue, undefined);
    const blob = JSON.stringify(out);
    for (const raw of FORBIDDEN) assert.ok(!blob.includes(raw), `${raw} leaked via group_id ${groupId}`);
  }

  // The customer-facing meaning is NOT lost — that is what makes removing the raw one safe.
  assert.match(asPriya(ticketOf({}, { [config.cf.groupCustom]: 'Rapid Era' })).queue_spoken,
    /service centre/i);
});

// ── B. CLOSURE REASON (defect 8) ─────────────────────────────────────────────

test('closureReason: runs ONLY on a resolved/closed ticket', () => {
  for (const status of [2, 3]) {
    assert.equal(closureReason(status, { queue: 'courier' }), null,
      'an open complaint has no closure reason to give');
  }
  assert.ok(closureReason(4, { queue: 'courier' }));
  assert.ok(closureReason(5, { queue: 'courier' }));
  assert.equal(closureReason(undefined, { queue: 'courier' }), null);
});

test('⭐ closureReason: the queue at closure answers first, in the client\'s own meanings', () => {
  assert.match(closureReason(5, { queue: 'courier' }), /courier movement/i); // C3: no longer asserts replacement
  assert.match(closureReason(5, { queue: 'no_comm_customer' }), /couldn't reach you.*fifteen days/i);
  assert.match(closureReason(5, { queue: 'no_technician_found' }), /couldn't arrange a technician/i);

  // The whole defect: these two must NOT be the same sentence.
  assert.notEqual(
    closureReason(5, { queue: 'courier' }),
    closureReason(5, { queue: 'no_comm_customer' }),
  );

  // The queue outranks the note — a couriered replacement is the outcome even if the
  // last note happens to mention the product working.
  assert.match(
    closureReason(5, { queue: 'courier', noteText: 'Product started working. Hence closed' }),
    /courier movement/i, // C3: courier queue no longer claims 'replacement' (defect #14)
  );
});

test('⭐ closureReason: the note CLASSIFIES, it is never quoted (safeLatestNote stays strict)', () => {
  const terse = "It's Started now 19:05";
  const shorthand = 'Product started working. Hence closed';

  // Normalised phrase out — none of the raw shorthand survives into it.
  const reason = closureReason(5, { queue: null, noteText: shorthand });
  assert.equal(reason, 'the product was reported working again');
  for (const fragment of ['19:05', 'Hence closed', 'Product started working']) {
    assert.ok(!reason.includes(fragment), `raw note text leaked: ${fragment}`);
  }
  assert.equal(closureReason(4, { noteText: 'Issue resolved, closing the ticket' }),
    'the product was reported working again');

  // …and the normaliser stops where certainty stops. This real account note plainly
  // means the product started — to a human. To a pattern it is indistinguishable from
  // "technician visit started now", so we return nothing rather than risk announcing a
  // repair that never happened.
  assert.equal(closureReason(5, { noteText: terse }), null);

  // ⛔ And safeLatestNote() is UNCHANGED — the note that fed the classifier is still
  // refused as something to read aloud. Fixing defect 8 by loosening it would have put
  // internal shorthand on a recorded line.
  const convos = [{ body_text: shorthand, private: true, created_at: new Date().toISOString() }];
  assert.equal(safeLatestNote(convos), null);

  const out = asPriya(ticketOf({ status: 5, conversations: convos },
    { [config.cf.groupCustom]: 'Courier' }));
  assert.equal(out.latest_update, undefined, 'the internal note must not be read aloud');
  assert.match(out.closure_reason, /courier movement/i); // C3
});

test('closureReason: no queue meaning and no matching note → null, not a guess', () => {
  assert.equal(closureReason(5, {}), null);
  assert.equal(closureReason(5, { queue: 'with_digicart', noteText: 'call back later' }), null);
  // Deliberately NOT normalised: "refund"/"replacement" wording in a note can mean the
  // opposite of what it says ("customer asking for refund, denied").
  assert.equal(closureReason(5, { noteText: 'customer asking for refund, denied' }), null);

  const out = asPriya(ticketOf({ status: 5, conversations: [] }, { [config.cf.groupCustom]: 'Warranty' }));
  assert.equal(out.closure_reason, undefined);
  assert.equal(out.status_label, 'completed and closed'); // she still has the status word
});

// ── C. THE REGISTRATION DATE (defect 17) ─────────────────────────────────────

test('formatDateSpoken: a finished date in Asia/Kolkata, or nothing', () => {
  assert.equal(formatDateSpoken('2026-06-18T05:30:00Z', 'Asia/Kolkata'), '18 June 2026');
  // Late UTC on the 17th is already the 18th in Kolkata — the customer's calendar wins.
  assert.equal(formatDateSpoken('2026-06-17T20:00:00Z', 'Asia/Kolkata'), '18 June 2026');
  assert.equal(formatDateSpoken(null), null);
  assert.equal(formatDateSpoken('not a date'), null);
});

test('formatStatus: Tara is handed the date AND the phrase, never bare arithmetic', () => {
  const out = asPriya(ticketOf({ created_at: '2026-06-18T05:30:00Z' }));
  assert.equal(out.registered_on, '18 June 2026');
  assert.equal(typeof out.registered_phrase, 'string');
  assert.equal(asPriya(ticketOf({ created_at: daysAgo(1) })).registered_phrase, 'yesterday');
  assert.equal(asPriya(ticketOf({ created_at: daysAgo(0) })).registered_phrase, 'today');
  // Unparseable timestamp: no invented date, and the phrase still degrades safely.
  const blind = asPriya(ticketOf({ created_at: null }));
  assert.equal(blind.registered_on, undefined);
  assert.equal(blind.registered_phrase, 'recently');
});

test('⭐ an unknown registration age is OMITTED, never emitted as null', () => {
  // The prompt tells Tara to read back what she is given, and every other optional field
  // on this response is simply absent when unknown. `days_since_registered: null` was the
  // one exception — a null in an LLM's context is a null it can say out loud.
  for (const created_at of [null, undefined, '', 'not a date', 'yesterday-ish']) {
    const out = asPriya(ticketOf({ created_at }));
    assert.ok(!('days_since_registered' in out),
      `days_since_registered must be absent, not null (created_at=${String(created_at)})`);
    assert.ok(!JSON.stringify(out).includes('null'), 'no null literal may cross the wire');
    // The degraded path is unchanged and still answerable.
    assert.equal(out.registered_phrase, 'recently');
    assert.equal(out.registered_on, undefined);
    assert.equal(out.sla_breached, undefined, 'an unknown age can never be an SLA breach');
    assert.ok(out.status_label, 'she still has the status word');
  }

  // A known age is unaffected — present, and a number.
  const known = asPriya(ticketOf({ created_at: daysAgo(4) }));
  assert.equal(typeof known.days_since_registered, 'number');
  assert.equal(known.days_since_registered, 4);
});

// ── D. PICKUP / DISPATCH STATE (defect 19) ───────────────────────────────────

test('formatStatus: service partner and field-agent ticket (defect 19)', () => {
  const out = asPriya(ticketOf({}, {
    [config.cf.servicePartner]: 'Rapid Era',
    cf_field_agent_ticket_number: 'FA-88213',
  }));
  // ⭐ A SPOKEN phrase crosses the wire, never the raw dropdown value. Same rule that keeps
  // the raw queue name out of this response: the live values are ops vocabulary — 'Others'
  // means nothing to a caller and 'On SIte Go' is misspelled on the desk itself.
  assert.equal(out.service_partner_spoken, 'with our authorised service partner');
  assert.equal(out.service_partner, undefined, 'the raw partner name must not cross the wire');
  assert.equal(out.field_agent_ticket, 'FA-88213');

  // Every live value resolves to something sayable, and none of them leaks the raw string.
  for (const raw of ['Rapid Era', 'On SIte Go', 'Others']) {
    const t = asPriya(ticketOf({}, { [config.cf.servicePartner]: raw }));
    assert.ok(t.service_partner_spoken, `${raw} must resolve to a spoken phrase`);
    assert.ok(
      !JSON.stringify(t).toLowerCase().includes(raw.toLowerCase()),
      `the raw value "${raw}" must appear nowhere in the response`,
    );
  }

  // 'No' is the dropdown's explicit "not sent to a partner" value — it is not a partner
  // name and must never surface as one.
  const notSent = asPriya(ticketOf({}, { [config.cf.servicePartner]: 'No' }));
  assert.equal(notSent.service_partner_spoken, undefined);
  const blank = asPriya(ticketOf());
  assert.equal(blank.service_partner_spoken, undefined);
  assert.equal(blank.field_agent_ticket, undefined);
});

// ── E. SLA AGING (defect 20) ─────────────────────────────────────────────────

test('isSlaBreached: only an OPEN case can outlive the SLA', () => {
  assert.equal(isSlaBreached(3, SLA_OPEN_DAYS + 1), true);
  assert.equal(isSlaBreached(2, 32), true);
  assert.equal(isSlaBreached(3, SLA_OPEN_DAYS), false, 'the boundary itself is not a breach');
  assert.equal(isSlaBreached(3, 2), false);
  // A closed complaint is not "late" — it is finished.
  assert.equal(isSlaBreached(4, 60), false);
  assert.equal(isSlaBreached(5, 60), false);
  assert.equal(isSlaBreached(3, null), false);
  assert.equal(isSlaBreached(3, undefined), false);
});

test('⭐ formatStatus: day 32 must NOT speak like day 2 (defect 20)', () => {
  const fresh = asPriya(ticketOf({ created_at: daysAgo(2) }));
  const stale = asPriya(ticketOf({ created_at: daysAgo(32) }));

  assert.equal(fresh.sla_breached, undefined);
  assert.equal(fresh.expected_next_step, nextStep(3));

  assert.equal(stale.sla_breached, true);
  assert.equal(stale.expected_next_step, SLA_BREACH_NEXT_STEP);
  assert.notEqual(stale.expected_next_step, fresh.expected_next_step);

  // The reassurance boilerplate is REPLACED, not appended: never quote "2 to 3 working
  // days" back to a customer who has already waited a month.
  assert.doesNotMatch(stale.expected_next_step, /2 to 3 working days/i);
  assert.match(stale.expected_next_step, /colleague|callback/i);

  // A month-old CLOSED complaint is not a breach.
  assert.equal(asPriya(ticketOf({ status: 5, created_at: daysAgo(32) })).sla_breached, undefined);
});

// ── F. ⭐ THE GATE STILL HOLDS ───────────────────────────────────────────────

test('⭐ NONE of the M-4 enrichment escapes the identity gate', () => {
  // The enrichment is the most case-specific material this response has ever carried —
  // where the unit physically is, who is holding it, when it was registered. An impostor
  // must learn that a complaint EXISTS and not one describable fact about it.
  const loaded = ticketOf({
    status: 5,
    created_at: daysAgo(32),
    conversations: [{ body_text: 'Product started working. Hence closed', private: true, created_at: new Date().toISOString() }],
  }, {
    [config.cf.groupCustom]: 'Courier',
    [config.cf.servicePartner]: 'Rapid Era',
    cf_field_agent_ticket_number: 'FA-88213',
  });

  for (const opts of [{ callerStatedName: 'Rahul Mehta' }, { callerStatedName: '' }, {}, undefined]) {
    const out = formatStatus(loaded, opts);
    assert.equal(out.found, true);
    assert.equal(out.name_matches, false);
    // Exact key set — the gate is enforced by construction, so nothing case-specific is
    // even built into the payload.
    assert.deepEqual(Object.keys(out).sort(), ['complaint_number', 'found', 'name_matches']);

    const blob = JSON.stringify(out);
    for (const secret of ['Courier', 'Rapid Era', 'FA-88213', 'courier movement', 'June']) {
      assert.ok(!blob.includes(secret), `M-4 field leaked past the identity gate: ${secret}`);
    }
  }

  // Same ticket, identity proved → the full picture.
  const ok = asPriya(loaded);
  assert.equal(ok.name_matches, true);
  assert.match(ok.closure_reason, /courier movement/i); // C3
  assert.equal(ok.service_partner_spoken, 'with our authorised service partner');
  assert.equal(ok.field_agent_ticket, 'FA-88213');
  assert.ok(ok.registered_on);
  // …and still no requester name, on either branch.
  assert.ok(!JSON.stringify(ok).toLowerCase().includes('sharma'));
  // Nor any raw ops vocabulary, even once identity is proved. The customer hears a phrase
  // truTRTL owns — never the internal queue or partner string.
  for (const opsWord of ['Rapid Era', 'with digiCART', 'No Comm from Customer']) {
    assert.ok(
      !JSON.stringify(ok).includes(opsWord),
      `raw ops vocabulary crossed the wire: ${opsWord}`,
    );
  }
});

// ── C1 FIX-2 (2026-07-23): by-PHONE must DISCLOSE, and say so, even on a wrong/absent name ──
// Real defect (issue #38): caller "वसीम" whose ticket requester is stored Latin "Washim" —
// cross-script, the name can never match — retried by phone and was STILL refused, because the
// server returned name_matches:false and the agent withholds on false. The by-phone response
// must report name_matches:TRUE (phone+brand IS the identity) so the agent reads the case out.
test('⭐ by-phone discloses on phone+brand even when the name is wrong or absent (issue #38)', () => {
  const t = ticketOf({}, { [config.cf.groupCustom]: 'with Technicians' });

  // Wrong name, but phone-verified → full disclosure, name_matches:true, name_via:'phone'.
  const wrongName = formatStatus(t, { callerStatedName: 'Totally Different', phoneVerified: true });
  assert.equal(wrongName.name_matches, true, 'phone-verified must signal disclose=true');
  assert.equal(wrongName.name_via, 'phone');
  assert.ok(wrongName.product && wrongName.status_label, 'the case detail must be present');

  // No name at all, phone-verified → still discloses (the वसीम/Washim escape hatch).
  const noName = formatStatus(t, { phoneVerified: true });
  assert.equal(noName.name_matches, true);
  assert.ok(noName.status_label);

  // ⛔ SECURITY UNCHANGED: by-ID path (no phoneVerified) with a wrong name still WITHHOLDS.
  const byId = formatStatus(t, { callerStatedName: 'Totally Different' });
  assert.equal(byId.name_matches, false);
  assert.deepEqual(Object.keys(byId).sort(), ['complaint_number', 'found', 'name_matches']);
  assert.equal(byId.product, undefined, 'by-id wrong name must leak nothing');
});
