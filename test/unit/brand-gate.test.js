// The two guardrails this line shipped without (dossier §9.1 🔴 #1). If any of these
// ever go red, a truTRTL caller can be told about another brand's customer's complaint,
// or an impostor can be told about a real customer's — treat a failure here as a live
// incident, not a broken test.
//
// (Kept in its own file rather than in helpers.test.js so the map/field work in the other
//  workstream cannot collide with it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../src/lib/config.js';
import { isBrandTicket, namesMatch, nameTokens, formatStatus } from '../../src/lib/ravan.js';

const BRAND = config.cf.brandValue; // 'truTRTL' — byte-for-byte the live option string

const ticketOf = (overrides = {}) => ({
  id: 11914,
  status: 3,
  created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
  custom_fields: {
    [config.cf.brand]: BRAND,
    [config.cf.product]: 'Ceiling Fan',           // cf_custom_tags (singular dropdown)
    [config.cf.productCategory]: 'Ceiling Fans',  // brand tree (plural)
  },
  requester: { name: 'Priya Sharma' },
  conversations: [
    { body_text: 'Dear Customer, a technician will visit soon.', private: true, created_at: new Date().toISOString() },
  ],
  ...overrides,
});

// ── ⭐ A. THE BRAND FILTER ────────────────────────────────────────────────────

test('⭐ brand filter: only truTRTL tickets pass', () => {
  assert.equal(isBrandTicket(ticketOf()), true);

  // The whole point: digicart.freshdesk.com is ONE desk shared by FOUR brands over ONE
  // ~5-digit id sequence, so any number a caller reads out lands on SOME brand's ticket.
  for (const other of ['MILTON', 'APARNA', 'FKSB', 'ELLE Home']) {
    assert.equal(
      isBrandTicket(ticketOf({ custom_fields: { [config.cf.brand]: other } })),
      false,
      `${other} ticket must not pass the truTRTL brand filter`,
    );
  }

  // Fails CLOSED on every degenerate shape — an unreadable brand is not our brand.
  assert.equal(isBrandTicket(null), false);
  assert.equal(isBrandTicket(undefined), false);
  assert.equal(isBrandTicket({}), false);
  assert.equal(isBrandTicket({ custom_fields: {} }), false);                       // no brand field
  assert.equal(isBrandTicket({ custom_fields: { [config.cf.brand]: null } }), false);
  assert.equal(isBrandTicket({ custom_fields: { [config.cf.brand]: '' } }), false);
  assert.equal(isBrandTicket(ticketOf({ custom_fields: undefined })), false);      // list endpoint dropped custom_fields
  // Strict equality: the option string is matched byte-for-byte, not case-folded.
  assert.equal(isBrandTicket({ custom_fields: { [config.cf.brand]: BRAND.toLowerCase() } }), false);
  assert.equal(isBrandTicket({ custom_fields: { [config.cf.brand]: ` ${BRAND} ` } }), false);
});

// ── ⭐ B. THE IDENTITY GATE ───────────────────────────────────────────────────

test('⭐ identity gate: forgiving where a real caller is, strict where an impostor is', () => {
  // A real caller, in both directions (the stated name may be shorter OR longer).
  assert.equal(namesMatch('Priya Sharma', 'Priya Sharma'), true);
  assert.equal(namesMatch('Priya', 'Priya Sharma'), true);          // first name only
  assert.equal(namesMatch('Priya Sharma', 'Priya'), true);          // the record is partial
  assert.equal(namesMatch('priya sharma', 'Sharma Priya'), true);   // order-insensitive
  assert.equal(namesMatch('  PRIYA   SHARMA ', 'Priya Sharma'), true);
  assert.equal(namesMatch('Mrs. Priya', 'priya sharma'), true);     // honorific stripped
  assert.equal(namesMatch('Priya ji', 'Priya Sharma'), true);

  // Not this caller.
  assert.equal(namesMatch('Priya Verma', 'Priya Sharma'), false);   // the surname contradicts
  assert.equal(namesMatch('Priyanka', 'Priya'), false);             // NO prefix matching
  assert.equal(namesMatch('Priyanka', 'Priya Sharma'), false);
  assert.equal(namesMatch('Rahul', 'Priya Sharma'), false);

  // Fails closed: an empty side can never prove an identity.
  assert.equal(namesMatch('', 'Priya Sharma'), false);
  assert.equal(namesMatch('Priya', ''), false);
  assert.equal(namesMatch(undefined, 'Priya Sharma'), false);
  assert.equal(namesMatch('Priya Sharma', undefined), false);
  assert.equal(namesMatch('', ''), false);
  assert.equal(namesMatch('Mr.', 'Priya Sharma'), false);           // honorific only → no tokens

  assert.equal(nameTokens('Mr. K. Sharma').join(','), 'k,sharma');
});

test('⭐ formatStatus: a matched name unlocks the case detail', () => {
  const out = formatStatus(ticketOf(), { callerStatedName: 'Priya' });
  assert.equal(out.found, true);
  assert.equal(out.name_matches, true);
  assert.equal(out.complaint_number, '11914');
  // truTRTL reads cf_custom_tags first, cf_product_category only as a fallback.
  assert.equal(out.product, 'Ceiling Fan');
  assert.match(out.latest_update, /technician/);
  assert.equal(out.status_label, 'in progress');
  assert.ok(out.days_since_registered >= 3 && out.days_since_registered <= 5);
  assert.ok(out.expected_next_step);

  // Even on the PASS branch the requester's real name never crosses the wire — only the
  // boolean does. A name in the model's context is a name Tara can read out.
  assert.equal(out.requester_name, undefined);
  assert.ok(!JSON.stringify(out).toLowerCase().includes('sharma'));
});

test('⭐ formatStatus: an unmatched or absent name withholds EVERYTHING case-specific', () => {
  for (const opts of [{ callerStatedName: 'Rahul Mehta' }, { callerStatedName: 'Priya Verma' },
    { callerStatedName: '' }, {}, undefined]) {
    const out = formatStatus(ticketOf(), opts);
    assert.equal(out.found, true, 'the caller may still learn that a complaint exists');
    assert.equal(out.name_matches, false);

    // The gate withholds STATUS too, not just the product/note — a wrong name must not
    // leak whether the case is resolved, how old it is, or what happens next. These are
    // the fields this line leaked before there was any identity step at all.
    assert.equal(out.product, undefined, 'product must be withheld until identity is proved');
    assert.equal(out.latest_update, undefined, 'latest_update must be withheld until identity is proved');
    assert.equal(out.status_label, undefined, 'status_label must be withheld until identity is proved');
    assert.equal(out.days_since_registered, undefined, 'days_since_registered must be withheld until identity is proved');
    assert.equal(out.expected_next_step, undefined, 'expected_next_step must be withheld until identity is proved');

    // Nothing beyond the three gate-safe keys may be built into the payload at all.
    assert.deepEqual(Object.keys(out).sort(), ['complaint_number', 'found', 'name_matches']);

    // ⭐ And the requester's real name must never reach the model in ANY field, on ANY
    // branch — serialise the whole object and look for it.
    const blob = JSON.stringify(out).toLowerCase();
    assert.ok(!blob.includes('priya'), 'the requester name leaked into the payload');
    assert.ok(!blob.includes('sharma'), 'the requester name leaked into the payload');
  }

  assert.deepEqual(formatStatus(null), { found: false });
});

test('formatStatus: the gate reads every requester shape Freshdesk returns', () => {
  // include=requester gives `requester.name`; some payloads give first/last; the contact
  // fallback covers the rest. A shape we cannot read must FAIL the gate, not pass it.
  assert.equal(formatStatus(ticketOf({ requester: { first_name: 'Priya', last_name: 'Sharma' } }),
    { callerStatedName: 'Priya' }).name_matches, true);
  assert.equal(formatStatus(ticketOf({ requester: undefined, contact: { name: 'Priya Sharma' } }),
    { callerStatedName: 'Sharma' }).name_matches, true);
  // No requester at all → nothing to match against → withheld.
  const blind = formatStatus(ticketOf({ requester: undefined }), { callerStatedName: 'Priya' });
  assert.equal(blind.name_matches, false);
  assert.equal(blind.product, undefined);
});
