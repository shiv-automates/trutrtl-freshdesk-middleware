// Unit tests for the pure helpers. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clean, tenDigit, variants, toStorage, isValidIndianMobile } from '../../src/lib/phone.js';
import { stripHtml, toOneSentence } from '../../src/lib/html-strip.js';
import { statusLabel, nextStep, isClosed } from '../../src/lib/status-map.js';
import { daysSince, daysSincePhrase } from '../../src/lib/time-since.js';
import {
  mapProduct, PRODUCT_CHOICES, mapCategory, mapSku, matchSku, TRUTRTL_CATEGORIES,
  isCategoryAvailable, isProductUnfilable, CATEGORY_UNAVAILABLE_PRODUCTS,
} from '../../src/lib/product-map.js';
import { config, brandTag } from '../../src/lib/config.js';
import { mapPlatform, PLATFORM_CHOICES, isUnmappedChannel } from '../../src/lib/platform-map.js';
import { unwrapParams, safeLatestNote, formatStatus, parseAfterCall } from '../../src/lib/ravan.js';
import {
  requiredCustomFields, validateComplaint, fieldFallbacks, todayISO, TicketFieldError,
  ORDER_DATE_NOT_CAPTURED,
} from '../../src/lib/ticket-fields.js';

test('phone: tenDigit + variants + storage', () => {
  assert.equal(tenDigit('+91-9876-543-210'), '9876543210');
  assert.equal(tenDigit('98 765 43210'), '9876543210');
  assert.equal(tenDigit('919876543210'), '9876543210');
  assert.equal(toStorage('9876543210'), '+919876543210');
  assert.ok(variants('+919876543210').includes('9876543210'));
  assert.ok(variants('9876543210').includes('+919876543210'));
  assert.equal(clean('+91 (98) 765'), '+9198765');
  assert.equal(isValidIndianMobile('9876543210'), true);
  assert.equal(isValidIndianMobile('1234567890'), false);
});

test('html-strip: tags, entities, trimming', () => {
  assert.equal(stripHtml('<p>Hello&nbsp;<b>world</b></p>'), 'Hello world');
  assert.equal(stripHtml("Dear&#39;s &amp; co"), "Dear's & co");
  const long = 'Technician visit being scheduled for your area. ' + 'x'.repeat(300);
  assert.ok(toOneSentence(long, 200).length <= 201);
  assert.equal(toOneSentence('Short note.'), 'Short note.');
});

test('status-map: labels + next steps + closed', () => {
  assert.equal(statusLabel(2), 'registered and open');
  assert.equal(statusLabel(3), 'in progress');
  assert.equal(statusLabel(5), 'completed and closed');
  assert.match(nextStep(2), /technician/i);
  assert.equal(isClosed(5), true);
  assert.equal(isClosed(2), false);
});

test('time-since: day math + phrasing', () => {
  const now = new Date('2026-06-08T12:00:00Z');
  assert.equal(daysSince('2026-06-08T05:00:00Z', 'Asia/Kolkata', now), 0);
  assert.equal(daysSince('2026-06-04T05:00:00Z', 'Asia/Kolkata', now), 4);
  assert.equal(daysSince(null, 'Asia/Kolkata', now), null);
  assert.equal(daysSincePhrase(0), 'today');
  assert.equal(daysSincePhrase(1), 'yesterday');
  assert.equal(daysSincePhrase(4), '4 days ago');
});

test('product-map: free text → exact dropdown choice', () => {
  assert.equal(mapProduct('48 inch ceiling fan'), 'Ceiling Fan');
  assert.equal(mapProduct('1.5L electric kettle'), 'Kettle');
  assert.equal(mapProduct('egg boiler 7 egg'), 'Egg boiler');
  assert.equal(mapProduct('digital air fryer'), 'Air fryer');
  assert.equal(mapProduct('grill sandwich maker'), 'Sandwich Maker');
  assert.equal(mapProduct('mixer grinder'), 'Mixer Grinder');
  assert.equal(mapProduct('something we do not sell'), null);
  for (const c of PRODUCT_CHOICES) assert.equal(mapProduct(c), c);
});

test('platform-map: free text → exact dropdown choice', () => {
  assert.equal(mapPlatform('amazon'), 'Amazon');
  assert.equal(mapPlatform('bought on flipkart'), 'Flipkart');
  assert.equal(mapPlatform('zepto'), 'Zepto');
  assert.equal(mapPlatform('the website'), 'Website');
  assert.equal(mapPlatform('swiggy instamart'), 'Swiggy');
  assert.equal(mapPlatform('big basket'), 'BigBasket');
  assert.equal(mapPlatform('unknown shop'), null);
  for (const c of PLATFORM_CHOICES) assert.equal(mapPlatform(c), c);
});

test('platform-map: unknown NEVER silently becomes Website (§9.1 #8)', () => {
  // The dropdown has no "Other", so an unrecognised platform has no correct value.
  assert.equal(mapPlatform('Other'), null);
  assert.equal(mapPlatform('some random shop'), null);
  assert.equal(mapPlatform('the corner store'), null);
  assert.equal(mapPlatform('croma'), null);
  // ⭐ 2026-07-20: Meesho and Jabong are no longer part of this story — the admin added
  // both to cf_purchased_from, so they map to themselves (see the dedicated test below).
  // Nothing is currently in the unmapped-channel state.
  assert.equal(isUnmappedChannel('amazon'), false);
  assert.equal(isUnmappedChannel('meesho'), false);
  assert.equal(isUnmappedChannel('some random shop'), false);
});

// ⭐ 2026-07-20 — THE CLIENT'S CURRENT BUY LIST, PINNED.
// Manish gave the complete list of places a customer can buy truTRTL today. Every one of
// the eight must reach a live cf_purchased_from value, or a customer reading the answer the
// agent just gave them ("you'll find it on Instamart") cannot then have their complaint
// filed — the worst possible pairing, because we sent them there ourselves.
// Two of the eight do NOT share a name with their dropdown value, and those are the
// fragile ones: Swiggy Instamart is stored as 'Swiggy', and truTRTL.com as 'Website'.
const CURRENT_BUY_LIST = [
  ['Amazon', 'Amazon'],
  ['amazon', 'Amazon'],
  ['Flipkart', 'Flipkart'],
  ['flipkart app', 'Flipkart'],
  // ⚠ NOT a 'Swiggy Instamart' value — the dropdown says 'Swiggy'.
  ['Swiggy Instamart', 'Swiggy'],
  ['instamart', 'Swiggy'],
  ['swiggy', 'Swiggy'],
  ['Blinkit', 'Blinkit'],
  ['blinkit', 'Blinkit'],
  ['Zepto', 'Zepto'],
  ['zepto app', 'Zepto'],
  ['JioMart', 'JioMart'],
  ['jio mart', 'JioMart'],
  ['BigBasket', 'BigBasket'],
  ['big basket', 'BigBasket'],
  // ⚠ NOT a 'truTRTL.com' value — the dropdown says 'Website'.
  ['truTRTL.com', 'Website'],
  ['trutrtl.com', 'Website'],
  ['your website', 'Website'],
  ['the official site', 'Website'],
];

test('⭐ platform-map: every channel on the 2026-07-20 buy list files today', () => {
  for (const [said, expected] of CURRENT_BUY_LIST) {
    const got = mapPlatform(said);
    assert.equal(
      got, expected,
      `"${said}" → ${got}, expected ${expected}. This is a channel the agent actively tells `
      + 'callers to buy from (client buy list, 2026-07-20), so an unmapped answer here means '
      + 'we send them to a shop and then cannot file their complaint.',
    );
    assert.ok(
      PLATFORM_CHOICES.includes(got),
      `"${said}" → ${got}, which is not a live cf_purchased_from value — the create 400s`,
    );
  }
});

test('⭐ platform-map: Meesho and Jabong FILE AS THEMSELVES (dropdown gained them 2026-07-20)', () => {
  // WHAT CHANGED. Both were treated as terminal `unmapped_channel` failures on the grounds
  // that cf_purchased_from had no value for them: a Meesho caller got no ticket at all and a
  // promise of a callback. The desk admin added both on 2026-07-20, so that refusal became
  // the defect — the same class as filing them as 'Website', pointing the other way. The
  // legacy 2024–25 Meesho buyer this refusal was written to protect is precisely the caller
  // it was costing a ticket.
  for (const c of ['Meesho', 'meesho', 'MEESHO', 'bought on Meesho', 'ordered it from meesho app']) {
    assert.equal(mapPlatform(c), 'Meesho', `"${c}" must file as Meesho`);
  }
  for (const c of ['Jabong', 'jabong', 'bought it on Jabong']) {
    assert.equal(mapPlatform(c), 'Jabong', `"${c}" must file as Jabong`);
  }
  // Both are live dropdown values, so the create cannot 400 on them.
  for (const c of ['Meesho', 'Jabong']) {
    assert.equal(PLATFORM_CHOICES.includes(c), true, `${c} must be a live cf_purchased_from value`);
  }
  assert.equal(PLATFORM_CHOICES.length, 12, 'the live dropdown has twelve values as of 2026-07-20');

  // ⚠ THE ORDERING TRAP, and the reason this assertion is worth more than the two above:
  // the phrase names a marketplace AND says the word "website". If /website/ were reached
  // first we would file a Meesho order as a truTRTL.com purchase — §9.1 #8 verbatim (wrong
  // return policy, wrong invoice requested), which is what the old null-return prevented.
  assert.equal(mapPlatform('bought it on the meesho website'), 'Meesho');
  assert.equal(mapPlatform('the jabong website'), 'Jabong');
  // The Website alias itself is untouched for everyone else.
  assert.equal(mapPlatform('your website'), 'Website');
  assert.equal(mapPlatform('trutrtl.com'), 'Website');

  // Neither is on the buy list Manish gave — they are legacy channels — and that no longer
  // matters for filing. Recognising a channel the customer really used is not an
  // endorsement of it; the ticket must say where they actually bought the product.
  for (const c of ['Meesho', 'Jabong']) {
    assert.equal(
      CURRENT_BUY_LIST.some(([, v]) => v === c), false,
      `${c} is not on the client's current buy list — it files anyway, for legacy owners`,
    );
  }
});

test('⭐ platform-map: the unmapped-channel seam still exists, and is currently empty', () => {
  // isUnmappedChannel() is what lets the route decline HONESTLY (terminal, callback) rather
  // than dragging an unfilable channel to the nearest legal-looking value — which on this
  // dropdown is always 'Website'. Nothing is in that state today, but the next channel
  // truTRTL sells on before the admin adds it will be, and the route, its reason code and
  // its spoken line must still be wired when that happens.
  assert.equal(typeof isUnmappedChannel, 'function');
  for (const c of ['Meesho', 'Jabong', 'amazon', 'croma', 'the corner store', '', null, undefined]) {
    assert.equal(isUnmappedChannel(c), false, `nothing is an unmapped channel today, including ${c}`);
  }
});

test('product-map: nested brand chain (category + SKU)', () => {
  assert.equal(mapCategory('48 inch ceiling fan'), 'Ceiling Fans');
  assert.equal(mapCategory('egg boiler 7 egg'), 'Egg Boilers');
  assert.equal(mapCategory('1.5L kettle'), 'Kettle');
  assert.equal(mapCategory('grill sandwich maker'), 'Sandwich Maker');
  assert.equal(mapCategory('nonsense'), null);
  // SKU must be a valid member of the category
  assert.ok(TRUTRTL_CATEGORIES['Ceiling Fans'].includes(mapSku('Ceiling Fans')));
  assert.equal(mapSku('Kettle', '1.5'), 'Electric-1.5 Kettle');
  assert.ok(TRUTRTL_CATEGORIES['Air fryer'].includes(mapSku('Air fryer')));
});

// ── ⭐ C. HONEST FAILURE ──────────────────────────────────────────────────────

test('⭐ product-map: the 8 filable categories map to the EXACT live category + SKU', () => {
  // These strings are load-bearing: cf_brand121540 is a chain Freshdesk VALIDATES, so a
  // single wrong character (spacing, plural, parenthesised model code) 400s the create.
  // The live tree is exactly eight categories — no more, no fewer. ⭐ M-12 (2026-07-18):
  // 'Electric chopper' is the eighth, created by the desk admin and read back from
  // GET /api/v2/ticket_fields. LOWERCASE c — the cf_custom_tags value for the same product
  // is 'Electric Chopper' with a capital C, and the two must never be interchanged.
  assert.deepEqual(Object.keys(TRUTRTL_CATEGORIES).sort(), [
    'Air fryer', 'Ceiling Fans', 'Egg Boilers', 'Electric chopper', 'Gas Stoves',
    'Kettle', 'Mixer Grinder', 'Sandwich Maker',
  ]);

  const LIVE_CHAIN = [
    ['48 inch ceiling fan', 'Ceiling Fans', 'Trutrtl-Smart-1200 MM'],
    ['my 1.5L kettle',      'Kettle',        'Electric-1.5 Kettle'],
    ['egg boiler 7 egg',    'Egg Boilers',   '7Egg Plastic - White'],
    ['digital air fryer',   'Air fryer',     'Manual(KZ-4505 M)'],
    ['grill sandwich maker', 'Sandwich Maker', 'Grill-Sandwich Maker'],
    ['mixer grinder',       'Mixer Grinder', 'Trutrtl-Nutri-Insta-2Jar'],
    ['gas stove',           'Gas Stoves',    'Shakti 2B'],
    ['chopper grinder',     'Electric chopper', 'Trutrtl-Smart-Chopper-Black'],
  ];
  for (const [said, category, sku] of LIVE_CHAIN) {
    assert.equal(mapCategory(said), category, `"${said}" → category`);
    assert.equal(mapSku(category), sku, `${category} → default SKU`);
    // The default SKU is always a real member of its own category, never borrowed.
    assert.ok(TRUTRTL_CATEGORIES[category].includes(sku), `${sku} is not a ${category} SKU`);
    assert.equal(isCategoryAvailable(mapProduct(said)), true, `${said} must be filable`);

    // …and the whole payload agrees with the chain.
    const f = requiredCustomFields({ product: said, platform: 'amazon' });
    assert.equal(f.cf_product_category, category);
    assert.equal(f.cf_product, sku);
  }

  // A caller-stated variant picks the right level-3 value instead of the default.
  assert.equal(mapSku('Ceiling Fans', 'Wave'), 'Trutrtl-Wave-600 MM');
  assert.equal(mapSku('Egg Boilers', '14Egg'), '14Egg Plastic - Black');
  assert.equal(mapSku('Air fryer', 'Digital'), 'Digital(KZ-4505 A1)');
  // Unknown variant → the documented default, never a fabricated string.
  assert.ok(TRUTRTL_CATEGORIES.Kettle.includes(mapSku('Kettle', 'no such model')));
  // No node in the tree → no SKU at all. Never borrow another category's.
  assert.equal(mapSku('Induction'), null);
  assert.equal(mapSku('Cooker'), null);
  assert.equal(mapSku('Iron'), null);
});

test('⭐ product-map: Induction / Cooker / Iron are recognised but NOT filable', () => {
  // ⭐ M-12: this list is now exactly these three. The recognise-only products (Toaster /
  // Water Boiler) and the chopper's departure from here are asserted in product-map.test.js,
  // which owns the whole M-1 / M-12 story.
  assert.deepEqual(CATEGORY_UNAVAILABLE_PRODUCTS, ['Induction', 'Cooker', 'Iron']);
  for (const p of ['Induction', 'Cooker', 'Iron']) {
    // We still recognise what the caller said — that is what lets us decline honestly.
    assert.equal(mapProduct(p), p);
    // But there is no node in the brand tree, so the chain cannot be built.
    assert.equal(mapCategory(p), null, `${p} must have no category`);
    assert.equal(isCategoryAvailable(p), false, `${p} must not be filable`);
  }
  assert.equal(isCategoryAvailable(null), false);
  assert.equal(isCategoryAvailable('Ceiling Fan'), true);
  assert.equal(isCategoryAvailable('Dishwasher'), false); // never sold, never filable
});

// Phrasings whose PRODUCT is Induction / Cooker / Iron — real truTRTL products with no node
// in the 7-category brand tree — but whose text ALSO matches a CATEGORY_RULES entry, so
// mapCategory() answers with a confident, wrong, filable category. Every one of these used
// to be filed as GAS STOVES / 'Shakti 2B': the unfilable-product check only ran when
// mapCategory() returned null, so a non-null wrong answer skipped it entirely. "induction
// stove" is commoner Indian English than a bare "induction", so this WAS the normal path.
const CATEGORY_COLLIDING_PHRASINGS = [
  'induction stove', 'induction cooktop', 'induction hob', 'induction stove top',
  'electric induction stove', 'induction gas stove', 'induction cooktop 2000w',
  'my induction stove is not heating', 'trutrtl induction stove',
  'induction stove not working', 'cooker hob',
];

// Unfilable phrasings that mapCategory() never claimed, so they took the honest path even
// before the precedence fix. Kept here so the fix cannot regress them either.
const ALREADY_HONEST_PHRASINGS = [
  'induction', 'Induction', 'induction cooker', 'induction cook top', 'induction plate',
  'induction burner', 'cooker', 'Cooker', 'pressure cooker', 'rice cooker',
  'electric cooker', 'my cooker is leaking', 'iron', 'Iron', 'steam iron', 'iron box',
  'dry iron', 'electric iron', 'my iron is not heating',
];

test('⭐ product-map: the two vocabularies COLLIDE — and the product, not the category, decides', () => {
  // This asserts the live data as it is, rather than endorsing it. The stove rule is broad
  // on purpose ("stove", "cooktop", "hob" all mean a gas stove to a caller who owns one),
  // and it is matched against the RAW text independently of mapProduct(). These two lines
  // are the entire defect: the category vocabulary says filable, the product says it is not.
  assert.equal(mapCategory('induction stove'), 'Gas Stoves');
  assert.equal(mapProduct('induction stove'), 'Induction');
  for (const said of CATEGORY_COLLIDING_PHRASINGS) {
    assert.ok(mapCategory(said), `"${said}" is only interesting while it still collides`);
    assert.equal(isProductUnfilable(mapProduct(said)), true, `"${said}" → unfilable product`);
  }

  // isProductUnfilable() answers ONLY from CATEGORY_UNAVAILABLE_PRODUCTS — it must never
  // consult CATEGORY_RULES, or it would inherit the collision it exists to overrule.
  for (const p of CATEGORY_UNAVAILABLE_PRODUCTS) assert.equal(isProductUnfilable(p), true);
  assert.equal(isProductUnfilable('  induction  '), true);
  assert.equal(isProductUnfilable('INDUCTION'), true);
  assert.equal(isProductUnfilable('Gas Stove'), false);
  assert.equal(isProductUnfilable('Ceiling Fan'), false);
  assert.equal(isProductUnfilable('Dishwasher'), false); // unrecognised ≠ unfilable
  assert.equal(isProductUnfilable(null), false);
});

test('⭐ ticket-fields: an unfilable product is declined WHATEVER category the rules matched', () => {
  for (const said of [...CATEGORY_COLLIDING_PHRASINGS, ...ALREADY_HONEST_PHRASINGS]) {
    const v = validateComplaint({ product: said, platform: 'amazon' });
    assert.equal(v.ok, false, `"${said}" must not be filable`);
    assert.equal(v.code, 'category_unavailable', `"${said}" → category_unavailable`);
    assert.throws(
      () => requiredCustomFields({ product: said, platform: 'amazon' }),
      (e) => e instanceof TicketFieldError && e.code === 'category_unavailable',
      `"${said}" must throw rather than build a payload`,
    );
  }

  // The refusal names the category it REFUSED to fabricate, so the log says what the old
  // code would have filed instead of leaving ops to guess.
  assert.match(
    validateComplaint({ product: 'induction stove', platform: 'amazon' }).message,
    /Refusing to file it as Gas Stoves/,
  );

  // The precedence must not swing the other way: a genuine gas stove is still a gas stove,
  // and text we never recognised is still "ask the caller again", not "admin gap".
  assert.equal(validateComplaint({ product: 'gas stove', platform: 'amazon' }).ok, true);
  assert.equal(validateComplaint({ product: 'dishwasher', platform: 'amazon' }).code, 'unknown_product');
});

test('⭐ the 7 filable products are untouched by the precedence change', () => {
  // A precedence edit is exactly the kind of change that could quietly start declining real
  // complaints, so every filable phrasing is asserted end-to-end: category + SKU + payload.
  const STILL_FILABLE = [
    ['gas stove', 'Gas Stoves', 'Shakti 2B'],
    ['3 burner gas stove', 'Gas Stoves', 'Shakti 2B'],
    ['stove', 'Gas Stoves', 'Shakti 2B'],
    ['cooktop', 'Gas Stoves', 'Shakti 2B'],
    ['hob', 'Gas Stoves', 'Shakti 2B'],
    ['cast iron gas stove', 'Gas Stoves', 'Shakti 2B'],   // "iron" must not hijack a stove
    ['48 inch ceiling fan', 'Ceiling Fans', 'Trutrtl-Smart-1200 MM'],
    ['table fan', 'Ceiling Fans', 'Trutrtl-Smart-1200 MM'],
    ['my 1.5L kettle', 'Kettle', 'Electric-1.5 Kettle'],
    ['iron kettle', 'Kettle', 'Electric-1.5 Kettle'],     // ditto for a kettle
    ['egg boiler 7 egg', 'Egg Boilers', '7Egg Plastic - White'],
    ['egg cooker', 'Egg Boilers', '7Egg Plastic - White'], // an "egg cooker" IS the boiler
    ['digital air fryer', 'Air fryer', 'Manual(KZ-4505 M)'],
    ['grill sandwich maker', 'Sandwich Maker', 'Grill-Sandwich Maker'],
    ['mixer grinder', 'Mixer Grinder', 'Trutrtl-Nutri-Insta-2Jar'],
    ['juicer', 'Mixer Grinder', 'Trutrtl-Nutri-Insta-2Jar'],
  ];
  for (const [said, category, sku] of STILL_FILABLE) {
    assert.equal(validateComplaint({ product: said, platform: 'amazon' }).ok, true, `"${said}" must stay filable`);
    assert.equal(isProductUnfilable(mapProduct(said)), false, `"${said}" → filable product`);
    const f = requiredCustomFields({ product: said, platform: 'amazon' });
    assert.equal(f.cf_product_category, category, `"${said}" → category`);
    assert.equal(f.cf_product, sku, `"${said}" → SKU`);
    assert.ok(TRUTRTL_CATEGORIES[category].includes(f.cf_product), `${sku} is not a ${category} SKU`);
  }
});

test('⭐ config: ONE brand-tag derivation, shared by both routes that tag a ticket', () => {
  // register-complaint.js hardcoded the literal 'trutrtl' while after-call.js derived its
  // own copy — one CF_BRAND_VALUE change away from the two routes tagging the same desk
  // differently. Both now import this. (The routes are asserted in brand-tag.test.js.)
  assert.equal(brandTag, 'trutrtl');
  assert.equal(brandTag, String(config.cf.brandValue).toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  assert.ok(brandTag.length <= 32, 'Freshdesk tags cap at 32 chars');
});

test('ticket-fields: requiredCustomFields produces a valid, complete payload', () => {
  const f = requiredCustomFields({
    platform: 'zepto', product: 'ceiling fan',
    orderId: 'X1', orderDate: '2026-04-01', city: 'Pune', state: 'MH', pin: 411001,
  });
  assert.equal(f.cf_brand121540, 'truTRTL');
  assert.equal(f.cf_product_category, 'Ceiling Fans');
  assert.ok(TRUTRTL_CATEGORIES['Ceiling Fans'].includes(f.cf_product));
  assert.equal(f.cf_purchased_from, 'Zepto');
  assert.equal(f.cf_given_to_service_partner, 'No');
  assert.equal(f.cf_group_custom, 'WITH DIGICART');
  assert.equal(f.cf_order_id, 'X1');
  assert.equal(f.cf_order_date, '2026-04-01');
  assert.equal(f.cf_city, 'Pune');
  assert.equal(f.cf_state, 'MH');
  assert.equal(f.cf_pin_code, 411001);
  // Every key the tenant requires on create must be present, or the create 400s.
  for (const k of ['cf_brand121540', 'cf_product_category', 'cf_product', 'cf_purchased_from',
    'cf_given_to_service_partner', 'cf_group_custom', 'cf_order_date', 'cf_order_id',
    'cf_city', 'cf_state', 'cf_pin_code']) {
    assert.ok(k in f, `missing required key ${k}`);
  }

  // Placeholders are STILL correct for optional detail the caller simply didn't have —
  // NA / NA / NA / 0 — so a create never 400s on a missing order id.
  const g = requiredCustomFields({ product: 'kettle', platform: 'amazon' });
  assert.equal(g.cf_order_id, 'NA');
  assert.equal(g.cf_city, 'NA');
  assert.equal(g.cf_state, 'NA');
  assert.equal(g.cf_pin_code, 0);
  assert.match(g.cf_order_date, /^\d{4}-\d{2}-\d{2}$/);
  // ⭐ M-7: this assertion used to read `assert.equal(g.cf_order_date, todayISO())` — it
  // pinned the defect in place. An uncaptured order date is now the "not captured"
  // sentinel, NEVER today, because warranty runs from this field. See order-date.test.js.
  assert.equal(g.cf_order_date, ORDER_DATE_NOT_CAPTURED);
  assert.notEqual(g.cf_order_date, todayISO());
  assert.equal(g.cf_purchased_from, 'Amazon');

  // ⭐ WHAT CHANGED (§9.8): a MISSING/unknown platform used to become 'Website' right
  // here — silently rewriting which return policy applies and which invoice we ask for.
  // Placeholders are for optional detail only; product and platform never get one.
  assert.throws(
    () => requiredCustomFields({ product: 'kettle' }),
    (e) => e instanceof TicketFieldError && e.code === 'unknown_platform',
  );
});

test('⭐ ticket-fields: NO silent fallbacks — it throws instead of fabricating', () => {
  // Real truTRTL products, in Tara's enum and in cf_custom_tags, with no node in the
  // 7-category brand tree. These used to be filed as CEILING FANS with the fabricated
  // model 'Trutrtl-Smart-1200 MM' — ops schedules technicians off those fields (§9.1 #2).
  for (const said of ['induction', 'Induction', 'cooker', 'pressure cooker', 'iron', 'steam iron']) {
    assert.throws(
      () => requiredCustomFields({ product: said, platform: 'amazon' }),
      (e) => e instanceof TicketFieldError && e.code === 'category_unavailable',
      `${said} must be refused as category_unavailable`,
    );
    assert.equal(validateComplaint({ product: said, platform: 'amazon' }).code, 'category_unavailable');
  }

  // Text we never recognised is a DIFFERENT verdict: ask the caller again, don't guess.
  for (const said of ['dishwasher', 'washing machine', 'something we do not sell']) {
    assert.throws(
      () => requiredCustomFields({ product: said, platform: 'amazon' }),
      (e) => e instanceof TicketFieldError && e.code === 'unknown_product',
      `${said} must be refused as unknown_product`,
    );
    assert.equal(validateComplaint({ product: said, platform: 'amazon' }).code, 'unknown_product');
  }

  // ⭐ 2026-07-20. Meesho / Jabong used to be refused here as `unmapped_channel` because the
  // dropdown had no value for them. It has both now, so they must BUILD A PAYLOAD — and one
  // that says Meesho, never 'Website'.
  for (const [p, expected] of [
    ['Meesho', 'Meesho'], ['meesho', 'Meesho'], ['bought it on the meesho website', 'Meesho'],
    ['Jabong', 'Jabong'], ['jabong', 'Jabong'],
  ]) {
    assert.equal(validateComplaint({ product: 'ceiling fan', platform: p }).ok, true, `${p} must be filable`);
    const f = requiredCustomFields({ product: 'ceiling fan', platform: p });
    assert.equal(f.cf_purchased_from, expected, `${p} → cf_purchased_from`);
  }

  // Any other unmapped platform text: never 'Website'.
  for (const p of ['unknown shop', 'Other', 'croma', 'the corner store']) {
    assert.throws(
      () => requiredCustomFields({ product: 'ceiling fan', platform: p }),
      (e) => e instanceof TicketFieldError && e.code === 'unknown_platform',
      `${p} must be refused as unknown_platform`,
    );
    assert.equal(validateComplaint({ product: 'ceiling fan', platform: p }).code, 'unknown_platform');
  }

  // routes/after-call.js used to call requiredCustomFields({}) — that must NOT yield a
  // ticket stamped Ceiling Fans / Trutrtl-Smart-1200 MM / Website / today.
  assert.throws(() => requiredCustomFields({}), TicketFieldError);
  assert.equal(validateComplaint({}).ok, false);

  // The happy path still clears the non-throwing pre-check.
  assert.equal(validateComplaint({ product: 'ceiling fan', platform: 'amazon' }).ok, true);
  // Product is checked BEFORE platform, so an unfilable product reports the product.
  assert.equal(validateComplaint({ product: 'induction', platform: 'meesho' }).code, 'category_unavailable');
});

test('ticket-fields: placeholders are flagged for the description, not hidden', () => {
  const n = fieldFallbacks({ product: 'ceiling fan', platform: 'amazon' });
  assert.equal(n.orderDateDefaulted, true);
  assert.equal(n.skuDefaulted, true);
  assert.equal(n.orderIdMissing, true);
  assert.equal(n.locationMissing, true);
  const text = n.lines.join('\n');
  assert.match(text, /warranty runs 1 year from the INVOICE date/i);
  assert.match(text, /Model not identified/i);
  assert.match(text, /cf_order_id is "NA"/i);
  assert.match(text, /Location incomplete.*cf_pin_code defaulted to 0/i);

  // A city+state with no numeric pin is still incomplete → still flagged, never silent.
  const bad = fieldFallbacks({ product: 'ceiling fan', platform: 'amazon', city: 'Pune', state: 'MH' });
  assert.equal(bad.locationMissing, true);

  const good = fieldFallbacks({
    product: 'ceiling fan', model: 'Wave', platform: 'amazon', orderId: 'X1',
    orderDate: '2026-04-01', city: 'Pune', state: 'MH', pin: 411001,
  });
  assert.equal(good.orderDateDefaulted, false);
  assert.equal(good.skuDefaulted, false);
  assert.equal(good.skuModelUnmatched, false);
  assert.equal(good.orderIdMissing, false);
  assert.equal(good.locationMissing, false);
  assert.deepEqual(good.lines, []);
});

test('⭐ matchSku: the mapper says whether the MODEL picked the SKU, or the default did', () => {
  // mapSku() always answers — Freshdesk validates the chain, so the payload must carry a
  // real SKU whatever the caller said. That is correct for the field and a lie in the
  // description, and the two were conflated: fieldFallbacks() inferred "the model is
  // confirmed" from "a model string was present". matchSku() reports the truth instead.
  assert.deepEqual(matchSku('Kettle', '1.5'), { sku: 'Electric-1.5 Kettle', matched: true });
  assert.deepEqual(matchSku('Ceiling Fans', 'Wave'), { sku: 'Trutrtl-Wave-600 MM', matched: true });
  assert.deepEqual(matchSku('Air fryer', 'Digital'), { sku: 'Digital(KZ-4505 A1)', matched: true });

  // A token that matches nothing still yields the documented default — flagged as such.
  assert.deepEqual(matchSku('Kettle', 'smart'), { sku: 'Electric-1.5 Kettle', matched: false });
  assert.deepEqual(matchSku('Kettle'), { sku: 'Electric-1.5 Kettle', matched: false });
  assert.deepEqual(matchSku('Kettle', '   '), { sku: 'Electric-1.5 Kettle', matched: false });
  assert.deepEqual(matchSku('Induction', 'anything'), { sku: null, matched: false });

  // mapSku() is unchanged for every existing caller — it is matchSku().sku.
  for (const [c, m] of [['Kettle', '1.5'], ['Kettle', 'smart'], ['Kettle', undefined],
    ['Ceiling Fans', 'Wave'], ['Induction', undefined], ['Egg Boilers', '14Egg']]) {
    assert.equal(mapSku(c, m), matchSku(c, m).sku, `mapSku(${c}, ${m}) must not have drifted`);
  }
});

test('⭐ a model token that matched NOTHING is reported, not silently defaulted', () => {
  // THE DEFECT: `skuDefaulted = !!sku && !o.model` asked whether a model string ARRIVED, not
  // whether it matched. 'smart' is one of the exact tokens Ravan's schema tells Tara to
  // send, and it matches no Kettle SKU — so the ticket carried 'Electric-1.5 Kettle' with
  // skuDefaulted:false and NO warning. Ops read a defaulted model as a confirmed one: the
  // same "a placeholder that looks like data" class the order-date fix existed to kill.
  const miss = fieldFallbacks({ product: 'kettle', platform: 'amazon', model: 'smart' });
  assert.equal(miss.skuDefaulted, true, 'an unmatched model IS a defaulted SKU');
  assert.equal(miss.skuModelUnmatched, true);
  const missText = miss.lines.join('\n');
  assert.match(missText, /"smart"/, 'the failing token must be named — it is the evidence');
  assert.match(missText, /does NOT match any Kettle model/i);
  assert.match(missText, /Electric-1\.5 Kettle/, 'and what was filed instead');
  // The payload still carries a LEGAL SKU: the chain is validated server-side, so refusing
  // here would cost the caller their ticket over a soft field.
  const f = requiredCustomFields({ product: 'kettle', platform: 'amazon', model: 'smart' });
  assert.equal(f.cf_product, 'Electric-1.5 Kettle');
  assert.ok(TRUTRTL_CATEGORIES.Kettle.includes(f.cf_product));

  // A model that DID match raises nothing at all, and is not called defaulted.
  const hit = fieldFallbacks({ product: 'kettle', platform: 'amazon', model: '1.5' });
  assert.equal(hit.skuDefaulted, false);
  assert.equal(hit.skuModelUnmatched, false);
  assert.doesNotMatch(hit.lines.join('\n'), /Model/i);

  // No model at all keeps its OWN wording — "not identified" is a different fact from
  // "you told us one and we filed a different one", and ops acts differently on each.
  const none = fieldFallbacks({ product: 'kettle', platform: 'amazon' });
  assert.equal(none.skuDefaulted, true);
  assert.equal(none.skuModelUnmatched, false);
  assert.match(none.lines.join('\n'), /Model not identified/i);
  assert.doesNotMatch(none.lines.join('\n'), /does NOT match/i);

  // The other tokens Tara is told to send, on the products they belong to.
  for (const [product, model, expected, matched] of [
    ['ceiling fan', 'smart', 'Trutrtl-Smart-1200 MM', true],
    ['ceiling fan', 'ultra', 'Trutrtl-Ultra-1200 MM', true],
    ['ceiling fan', '1.5', 'Trutrtl-Smart-1200 MM', false],
    ['kettle', 'multipurpose', 'Multipurpose-1.3Kettle', true],
    ['air fryer', '12L', 'Trutrtl-Airfryer-12L', true],
    ['egg boiler', 'mrb', 'Trutrtl-7Egg-Mrb', true],
  ]) {
    const fb = fieldFallbacks({ product, platform: 'amazon', model });
    const payload = requiredCustomFields({ product, platform: 'amazon', model });
    assert.equal(payload.cf_product, expected, `${product} + "${model}" → cf_product`);
    assert.equal(fb.skuDefaulted, !matched, `${product} + "${model}" → skuDefaulted`);
    assert.equal(fb.skuModelUnmatched, !matched, `${product} + "${model}" → unmatched flag`);
  }
});

test('ravan: unwrapParams handles flat + wrapped', () => {
  assert.deepEqual(unwrapParams({ complaint_number: '123' }), { complaint_number: '123' });
  assert.deepEqual(unwrapParams({ args: { complaint_number: '123' } }), { complaint_number: '123' });
  assert.deepEqual(unwrapParams({ parameters: { phone_number: '9' } }), { phone_number: '9' });
  assert.deepEqual(unwrapParams(null), {});
});

test('ravan: safeLatestNote only reads customer-facing notes', () => {
  const convos = [
    { body_text: 'Internal: tech assigned', private: true, created_at: '2026-06-01T10:00:00Z' },
    { body_text: 'Dear Customer, your technician visit is scheduled tomorrow.', private: true, created_at: '2026-06-02T10:00:00Z' },
    { body_text: 'It started now 19:05', private: true, created_at: '2026-06-03T10:00:00Z' },
  ];
  // newest safe note is the "Dear Customer" one (the terse one is skipped)
  assert.match(safeLatestNote(convos), /technician visit is scheduled/);
  // all-internal → null
  assert.equal(safeLatestNote([{ body_text: 'terse', private: true, created_at: '2026-06-03T10:00:00Z' }]), null);
  // public reply is allowed
  assert.match(
    safeLatestNote([{ body_text: 'We have shipped your replacement.', private: false, created_at: '2026-06-03T10:00:00Z' }]),
    /replacement/,
  );
});

test('ravan: formatStatus produces the voice shape', () => {
  // NOTE: the case detail is now GATED on the identity check — passing a caller-stated
  // name that matches the ticket's requester is what unlocks product / status_label /
  // days_since_registered / expected_next_step / latest_update. See
  // test/unit/brand-gate.test.js for the gate itself; this file keeps the shape test.
  const ticket = {
    id: 11914,
    status: 3,
    created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    custom_fields: { cf_custom_tags: 'Ceiling Fan' },
    requester: { name: 'Priya Sharma' },
    conversations: [
      { body_text: 'Dear Customer, a technician will visit soon.', private: true, created_at: new Date().toISOString() },
    ],
  };
  const out = formatStatus(ticket, { callerStatedName: 'Priya' });
  assert.equal(out.found, true);
  assert.equal(out.complaint_number, '11914');
  assert.equal(out.name_matches, true);
  // truTRTL reads cf_custom_tags FIRST, cf_product_category only as a fallback.
  assert.equal(out.product, 'Ceiling Fan');
  assert.equal(out.status_label, 'in progress');
  assert.ok(out.days_since_registered >= 3 && out.days_since_registered <= 5);
  assert.match(out.latest_update, /technician/);
  assert.ok(out.expected_next_step);
  assert.deepEqual(formatStatus(null), { found: false });
});

test('ravan: parseAfterCall is defensive across shapes', () => {
  const wrapped = parseAfterCall({
    event: 'call.completed',
    data: {
      call_session_id: 'abc',
      caller_number: '+919876543210',
      summary: 'Fan issue',
      post_call_analysis: { sentiment: 'negative', next_steps: 'send video' },
      transcripts: [{ role: 'agent', message: { content: 'Hello' } }, { role: 'user', content: 'Hi' }],
    },
  });
  assert.equal(wrapped.callId, 'abc');
  assert.equal(wrapped.phone, '+919876543210');
  assert.equal(wrapped.sentiment, 'negative');
  assert.equal(wrapped.nextSteps, 'send video');

  const flat = parseAfterCall({ call_id: 'x1', phone: '9876543210', summary: 'hi', sentiment: 'positive' });
  assert.equal(flat.callId, 'x1');
  assert.equal(flat.phone, '9876543210');
  assert.equal(flat.sentiment, 'positive');
});

test('⭐ ravan: parseAfterCall reads product/platform only when STATED, never inferred', () => {
  const stated = parseAfterCall({ data: { call_id: 'x', product: 'ceiling fan', platform: 'Amazon' } });
  assert.equal(stated.product, 'ceiling fan');
  assert.equal(stated.platform, 'Amazon');

  // A summary that MENTIONS a product must not become a product field — that is exactly
  // how an after-call ticket ends up stamped with something the caller never said.
  const inferred = parseAfterCall({ data: { call_id: 'y', summary: 'Caller has a ceiling fan problem' } });
  assert.equal(inferred.product, null);
  assert.equal(inferred.platform, null);
});
