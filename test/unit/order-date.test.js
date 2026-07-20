// M-3 + M-7 — the product dropdown, and the purchase date that used to say "today".
// Run with: npm test
//
// Both defects share one shape: a field that LOOKED filled and was not evidence of
// anything. cf_custom_tags was never written at all (so voice tickets fell out of
// digiCART's saved views), and cf_order_date was stamped with today's date on every call
// where the caller answered Tara's "roughly when did you get it?" in words — which is
// every call — on a desk where warranty is assessed from that field.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  requiredCustomFields, fieldFallbacks, normalizeOrderDate, todayISO,
  ORDER_DATE_NOT_CAPTURED,
} from '../../src/lib/ticket-fields.js';
import { config } from '../../src/lib/config.js';
import { PRODUCT_CHOICES, TRUTRTL_CATEGORIES } from '../../src/lib/product-map.js';

// A fixed call time so nothing here depends on the wall clock. 18:00 UTC on 18 July 2026
// is 23:30 IST the SAME day — deliberately late enough that a timezone bug would show up
// as an off-by-one day.
const CALL = new Date('2026-07-18T18:00:00Z');

// ─── M-3 ───────────────────────────────────────────────────────────────────────────────

test('⭐ M-3: the product dropdown is actually written — cf_custom_tags is no longer empty', () => {
  const f = requiredCustomFields({ product: 'ceiling fan', platform: 'amazon' }, CALL);
  assert.equal(f[config.cf.product], 'Ceiling Fan');
  assert.equal(f.cf_custom_tags, 'Ceiling Fan');   // the literal key ops filters views on
  // The bug was the ABSENCE of the key, so assert presence explicitly: a saved view that
  // filters on cf_custom_tags cannot see a ticket that does not carry it.
  assert.ok('cf_custom_tags' in f, 'cf_custom_tags missing — the ticket drops out of product views');
});

test('⭐ M-3: SINGULAR tag vs PLURAL category — the two vocabularies never cross', () => {
  // Every filable product, checked on both fields at once. If a future edit ever fills
  // cf_custom_tags from mapCategory() (or vice versa), these pairs stop matching.
  const CASES = [
    ['ceiling fan', 'Ceiling Fan', 'Ceiling Fans'],
    ['fan making noise', 'Ceiling Fan', 'Ceiling Fans'],
    ['egg boiler', 'Egg boiler', 'Egg Boilers'],       // singular is lower-case 'boiler'
    ['gas stove', 'Gas Stove', 'Gas Stoves'],
    ['kettle', 'Kettle', 'Kettle'],                    // these two happen to coincide
    ['air fryer', 'Air fryer', 'Air fryer'],
    ['sandwich maker', 'Sandwich Maker', 'Sandwich Maker'],
    ['mixer grinder', 'Mixer Grinder', 'Mixer Grinder'],
  ];
  for (const [said, tag, category] of CASES) {
    const f = requiredCustomFields({ product: said, platform: 'amazon' }, CALL);
    assert.equal(f.cf_custom_tags, tag, `"${said}" → cf_custom_tags`);
    assert.equal(f.cf_product_category, category, `"${said}" → cf_product_category`);
    // The tag must be a verified-live dropdown value, and the category a verified-live
    // node of the brand tree. Neither list may be borrowed from the other.
    assert.ok(PRODUCT_CHOICES.includes(f.cf_custom_tags), `${tag} is not a cf_custom_tags value`);
    assert.ok(TRUTRTL_CATEGORIES[f.cf_product_category], `${category} is not a brand-tree category`);
  }
  // The two plural-only categories must NEVER appear on the singular dropdown.
  for (const plural of ['Ceiling Fans', 'Egg Boilers', 'Gas Stoves']) {
    assert.equal(PRODUCT_CHOICES.includes(plural), false, `${plural} leaked into cf_custom_tags`);
  }
});

test('M-3: an unmappable product leaves the dropdown UNSET, never guessed — and says so', () => {
  // 'Ceiling Fans' (the PLURAL category name) is a valid category but matches no product
  // choice — /\bfan\b/ does not match "Fans". The category chain still files; the optional
  // dropdown is simply absent rather than filled with the plural string.
  const f = requiredCustomFields({ product: 'Ceiling Fans', platform: 'amazon' }, CALL);
  assert.equal(f.cf_product_category, 'Ceiling Fans');
  assert.equal('cf_custom_tags' in f, false, 'an unmapped product must not write the dropdown');

  const fb = fieldFallbacks({ product: 'Ceiling Fans', platform: 'amazon' }, CALL);
  assert.equal(fb.productTagMissing, true);
  assert.match(fb.lines.join('\n'), /Product dropdown not set/i);
  assert.match(fb.lines.join('\n'), /left EMPTY rather than guessed/i);

  // A product we DO map raises no such line.
  assert.equal(fieldFallbacks({ product: 'ceiling fan', platform: 'amazon' }, CALL).productTagMissing, false);
});

// ─── M-7 ───────────────────────────────────────────────────────────────────────────────

test('⭐ M-7: an uncaptured order date is the sentinel — never today', () => {
  // THE defect. Tara asks "roughly when did you get it?"; anything unresolvable used to
  // become todayISO(), so a two-year-old fan looked bought this morning and warranty was
  // assessed off it.
  for (const said of [undefined, null, '', '   ', 'not sure', 'i forgot', 'no idea']) {
    const f = requiredCustomFields({ product: 'ceiling fan', platform: 'amazon', orderDate: said }, CALL);
    assert.equal(f.cf_order_date, ORDER_DATE_NOT_CAPTURED, `"${said}" must file the sentinel`);
    assert.notEqual(f.cf_order_date, todayISO(), `"${said}" must NEVER file today`);
  }
  // The sentinel is unmistakable — and it round-trips to "unknown" rather than being
  // re-read as a 1900 purchase.
  assert.equal(ORDER_DATE_NOT_CAPTURED, '1900-01-01');
  assert.deepEqual(normalizeOrderDate(ORDER_DATE_NOT_CAPTURED, CALL), { iso: null, precision: 'unknown' });
  // The key is still PRESENT: cf_order_date is required on create and the middleware must
  // never turn a real complaint into a 400. ([CONFIRM] whether null is accepted — until
  // that is checked against the live desk, the sentinel is what ships.)
  const f = requiredCustomFields({ product: 'kettle', platform: 'amazon' }, CALL);
  assert.ok('cf_order_date' in f);
});

test('⭐ M-7: normalizeOrderDate resolves what callers actually say, against the call time', () => {
  const EXACT = [
    ['2026-05-26', '2026-05-26'],
    ['2026-5-6', '2026-05-06'],
    ['26/05/2026', '2026-05-26'],     // DAY-first: an Indian desk, dd.mm.yyyy on the subject
    ['05.06.2026', '2026-06-05'],     // → 5 June, not 6 May
    ['26-05-26', '2026-05-26'],
    ['26 May 2026', '2026-05-26'],
    ['May 26, 2026', '2026-05-26'],
    ['today', '2026-07-18'],
    ['yesterday', '2026-07-17'],
    ['day before yesterday', '2026-07-16'],
  ];
  for (const [said, iso] of EXACT) {
    assert.deepEqual(normalizeOrderDate(said, CALL), { iso, precision: 'exact' }, `"${said}"`);
  }

  const APPROXIMATE = [
    ['two months ago', '2026-05-18'],
    ['about two months ago', '2026-05-18'],       // Tara's own question invites the hedge
    ['roughly 2 months back', '2026-05-18'],
    ['a month ago', '2026-06-18'],
    ['couple of months ago', '2026-05-18'],
    ['3 weeks ago', '2026-06-27'],
    ['ten days ago', '2026-07-08'],
    ['one year old', '2025-07-18'],
    ['two years ago', '2024-07-18'],
    ['last month', '2026-06-18'],
    ['last week', '2026-07-11'],
    ['last year', '2025-07-18'],
    ['26 May', '2026-05-26'],                     // year INFERRED → never called exact
    ['26th May', '2026-05-26'],
    ['may 26', '2026-05-26'],
    ['26 December', '2025-12-26'],                // most recent PAST December
    ['last January', '2026-01-01'],               // day unknown → the 1st
    ['in March', '2026-03-01'],
    ['March 2025', '2025-03-01'],
    ['2025', '2025-01-01'],
  ];
  for (const [said, iso] of APPROXIMATE) {
    assert.deepEqual(normalizeOrderDate(said, CALL), { iso, precision: 'approximate' }, `"${said}"`);
  }

  for (const said of [
    undefined, null, '', 'not sure', 'some time back', 'when i moved house',
    'diwali', '99/99/2026', '2026-13-45', '1899-01-01',
    '2026-12-25',           // the future: nobody bought it next December
    'tomorrow',
  ]) {
    assert.deepEqual(normalizeOrderDate(said, CALL), { iso: null, precision: 'unknown' }, `"${said}"`);
  }
});

test('⭐ M-7 FIX: the answer Phase 2.4 actually asks for — "<month> last year"', () => {
  // "which month and year did you buy it?" produces exactly this shape in English, and it
  // was the one month form the parser did NOT handle: the LEADING "last March" worked, the
  // TRAILING "March last year" fell through to the 1900 sentinel. Day unknown → the 1st,
  // which is the earliest it could be, so it never flatters the warranty.
  const CASES = [
    ['March last year', '2025-03-01'],
    ['march last year', '2025-03-01'],
    ['December last year', '2025-12-01'],
    ['jan last year', '2025-01-01'],
    ['March this year', '2026-03-01'],
    ['june this year', '2026-06-01'],
    ['March last saal', '2025-03-01'],     // the Hinglish year word, same shape
    ['march pichle saal', '2025-03-01'],
  ];
  for (const [said, iso] of CASES) {
    assert.deepEqual(normalizeOrderDate(said, CALL), { iso, precision: 'approximate' }, `"${said}"`);
  }
  // The leading form still works, and the two must not disagree about which year they mean.
  assert.equal(normalizeOrderDate('last March', CALL).iso, '2026-03-01');   // most recent PAST March
  assert.equal(normalizeOrderDate('March last year', CALL).iso, '2025-03-01'); // the calendar year before
  // "August this year" on 18 July is still in the future — honest unknown, never a guess.
  assert.deepEqual(normalizeOrderDate('August this year', CALL), { iso: null, precision: 'unknown' });
});

test('⭐ M-7 FIX: the Hinglish half of a Hinglish-locked call', () => {
  // Tara's prompt locks the call to Hinglish, so "do mahine pehle" is at least as likely an
  // answer as "two months ago" — and every Hinglish form used to file the 1900-01-01
  // sentinel, i.e. the parser was English-only on a call that is not. Warranty is assessed
  // from this field, so that was a silent data loss on a large share of calls.
  const CASES = [
    ['do mahine pehle', '2026-05-18'],
    ['do mahine pahle', '2026-05-18'],
    ['2 mahine pehle', '2026-05-18'],
    ['do mahine', '2026-05-18'],            // "pehle" optional, exactly as "ago" is
    ['teen mahine pehle', '2026-04-18'],
    ['6 mahine pehle', '2026-01-18'],
    ['2 saal pehle', '2024-07-18'],
    ['do saal pehle', '2024-07-18'],
    ['char saal pehle', '2022-07-18'],
    ['ek saal pehle', '2025-07-18'],
    ['ek saal purana', '2025-07-18'],
    ['do saal ho gaye', '2024-07-18'],
    ['ek hafte pehle', '2026-07-11'],
    ['do hafte pehle', '2026-07-04'],
    ['das din pehle', '2026-07-08'],
    ['10 din pehle', '2026-07-08'],
    ['pichle saal', '2025-07-18'],
    ['pichhle saal', '2025-07-18'],
    ['pichle mahine', '2026-06-18'],
    ['pichle hafte', '2026-07-11'],
  ];
  for (const [said, iso] of CASES) {
    assert.deepEqual(normalizeOrderDate(said, CALL), { iso, precision: 'approximate' }, `"${said}"`);
  }
  // Hinglish resolves against the SAME injected IST clock — no second code path, no drift.
  assert.equal(normalizeOrderDate('pichle mahine', new Date('2026-03-31T06:00:00Z')).iso, '2026-02-28');
  assert.equal(normalizeOrderDate('do mahine pehle', CALL).iso, normalizeOrderDate('two months ago', CALL).iso);
  assert.equal(normalizeOrderDate('pichle saal', CALL).iso, normalizeOrderDate('last year', CALL).iso);

  // Still HONEST, not eager: a unit with no number, a number with no unit, and ordinary
  // Hinglish that isn't a date at all must stay unknown rather than become a guess.
  for (const said of ['saal', 'mahine', 'pehle', 'do', 'pata nahi', 'yaad nahi', 'bahut pehle']) {
    assert.deepEqual(normalizeOrderDate(said, CALL), { iso: null, precision: 'unknown' }, `"${said}"`);
  }

  // …and the whole ticket agrees: the date reaches cf_order_date and is flagged approximate,
  // with the caller's own Hinglish quoted back for ops.
  const fb = fieldFallbacks({ product: 'kettle', platform: 'amazon', orderDate: 'do saal pehle' }, CALL);
  assert.equal(fb.orderDatePrecision, 'approximate');
  assert.equal(fb.orderDateFiled, '2024-07-18');
  assert.match(fb.lines.join('\n'), /do saal pehle/);
  const f = requiredCustomFields({ product: 'kettle', platform: 'amazon', orderDate: 'do saal pehle' }, CALL);
  assert.equal(f.cf_order_date, '2024-07-18');
  assert.notEqual(f.cf_order_date, ORDER_DATE_NOT_CAPTURED);
});

test('M-7: the resolved date is the IST calendar day, not the server\'s', () => {
  // 23:30 IST on the 18th is still 18:00 UTC on the 18th; 19:00 UTC is 00:30 IST on the
  // 19th. "today" must follow Asia/Kolkata, or every late-evening call files yesterday.
  assert.equal(normalizeOrderDate('today', new Date('2026-07-18T18:00:00Z')).iso, '2026-07-18');
  assert.equal(normalizeOrderDate('today', new Date('2026-07-18T19:00:00Z')).iso, '2026-07-19');
  // Month arithmetic clamps rather than rolling over: 31 March − 1 month is 28 February,
  // not 3 March, so "last month" can never land in the wrong month.
  assert.equal(normalizeOrderDate('last month', new Date('2026-03-31T06:00:00Z')).iso, '2026-02-28');
});

test('⭐ M-7: the description tells ops exactly which of the three states the date is in', () => {
  const unknown = fieldFallbacks({ product: 'ceiling fan', platform: 'amazon' }, CALL);
  assert.equal(unknown.orderDatePrecision, 'unknown');
  assert.equal(unknown.orderDateISO, null);
  assert.equal(unknown.orderDateFiled, ORDER_DATE_NOT_CAPTURED);
  assert.equal(unknown.orderDateDefaulted, true);
  assert.match(unknown.lines.join('\n'), /Order date NOT captured/i);
  assert.match(unknown.lines.join('\n'), /1900-01-01/);
  assert.match(unknown.lines.join('\n'), /warranty runs 1 year from the INVOICE date/i);
  // It must not claim the field says today — that is the sentence ops used to read.
  assert.doesNotMatch(unknown.lines.join('\n'), /set to today/i);

  const approx = fieldFallbacks(
    { product: 'ceiling fan', platform: 'amazon', orderDate: 'about two months ago' }, CALL,
  );
  assert.equal(approx.orderDatePrecision, 'approximate');
  assert.equal(approx.orderDateISO, '2026-05-18');
  assert.equal(approx.orderDateDefaulted, true);   // an inferred date is not a captured one
  const approxText = approx.lines.join('\n');
  assert.match(approxText, /Order date is APPROXIMATE/i);
  assert.match(approxText, /about two months ago/);   // the caller's own words, quoted back
  assert.match(approxText, /2026-05-18/);             // and what we resolved them to
  assert.match(approxText, /warranty runs 1 year from the INVOICE date/i);
  // ...and the ticket carries that same date, so the description can never describe a
  // field the payload doesn't have.
  const f = requiredCustomFields(
    { product: 'ceiling fan', platform: 'amazon', orderDate: 'about two months ago' }, CALL,
  );
  assert.equal(f.cf_order_date, approx.orderDateFiled);

  const exact = fieldFallbacks({
    product: 'ceiling fan', model: 'Wave', platform: 'amazon', orderId: 'X1',
    orderDate: '26/05/2026', city: 'Pune', state: 'MH', pin: 411001,
  }, CALL);
  assert.equal(exact.orderDatePrecision, 'exact');
  assert.equal(exact.orderDateFiled, '2026-05-26');
  assert.equal(exact.orderDateDefaulted, false);
  assert.deepEqual(exact.lines, []);   // real data raises no warning at all
  assert.equal(
    requiredCustomFields({ product: 'ceiling fan', platform: 'amazon', orderDate: '26/05/2026' }, CALL).cf_order_date,
    '2026-05-26',
  );
});

test('M-7: a garbled date never costs the caller their ticket', () => {
  // Rule 4 of the contract: the middleware must never 500 or refuse over a soft field.
  for (const junk of [{}, [], 42, NaN, 'asdf', '\n\n', new Date('nonsense')]) {
    const f = requiredCustomFields({ product: 'kettle', platform: 'amazon', orderDate: junk }, CALL);
    assert.equal(f.cf_order_date, ORDER_DATE_NOT_CAPTURED);
    assert.equal(f.cf_custom_tags, 'Kettle');
    const fb = fieldFallbacks({ product: 'kettle', platform: 'amazon', orderDate: junk }, CALL);
    assert.equal(fb.orderDatePrecision, 'unknown');
    assert.ok(fb.lines.length > 0);
  }
  // A real Date object (a caller path that already parsed) is honoured, not discarded.
  assert.deepEqual(
    normalizeOrderDate(new Date('2026-05-26T10:00:00Z'), CALL),
    { iso: '2026-05-26', precision: 'exact' },
  );
});
