// ⭐ M-11 / M-12 — regression tests for the product vocabulary. Run with: npm test
//
// This file exists because of ONE failure mode: RULE ORDER. Both mappers are first-match-
// wins, and every chopper phrasing below ALSO matches /\b(mixer|grinder|juicer|blender)\b/.
//
// ⚠ THE STAKES WENT UP ON 2026-07-18 (M-12). Until the desk admin created the 'Electric
// chopper' node, a mis-ordered rule was caught by a SECOND net: the chopper sat on
// CATEGORY_UNAVAILABLE_PRODUCTS, so isProductUnfilable() refused the create no matter what
// the category rules claimed to have seen, and the worst case was an honest refusal. That
// net is GONE — the chopper is a fully filable product now — so the CATEGORY_RULES ordering
// is the ONLY thing standing between "chopper grinder" and a real, confident, WRONG
// Mixer Grinder / 'Trutrtl-Nutri-Insta-2Jar' ticket that ops dispatches a technician from
// while Tara reads back its complaint number. These tests got MORE important, not less.
//
// So the assertions here are deliberately blunt and duplicated at four levels (product tag,
// category, ticket payload, and the source order itself): a reorder must fail LOUDLY, in
// more than one place, with a message that says what happened — not merely stop being
// covered.
//
// ⚠ AND TWO CASINGS THAT MUST NEVER MEET. cf_custom_tags says 'Electric Chopper' (capital
// C); cf_product_category says 'Electric chopper' (lowercase c). Both verified live against
// GET /api/v2/ticket_fields — they are different fields with different option lists, so
// copying either string into the other field writes an illegal value and the create 400s.
// It is the singular/plural trap (Ceiling Fan vs Ceiling Fans) in a new costume, and the
// payload test below pins both casings on ONE payload so neither can drift toward the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  mapProduct, mapCategory, mapSku, matchSku, isProductUnfilable, isCategoryAvailable,
  isMappingPending, PRODUCT_CHOICES, FRESHDESK_PRODUCT_TAGS, RECOGNISED_ONLY_PRODUCTS,
  CATEGORY_UNAVAILABLE_PRODUCTS, PENDING_MAPPING_PRODUCTS, TRUTRTL_CATEGORIES,
} from '../../src/lib/product-map.js';
import {
  validateComplaint, requiredCustomFields, TicketFieldError,
} from '../../src/lib/ticket-fields.js';

// The compound phrasings are the trap. A caller almost never says a bare "chopper": they
// say "chopper grinder" (the marketplace listing name), "chopper cum grinder", "chopper
// mixer" or "mini chopper blender" — and every one of those contains a word the mixer rule
// owns. This is the DEFAULT path, not an edge case.
const CHOPPER_PHRASINGS = [
  'chopper grinder',
  'chopper cum grinder',
  'chopper mixer',
  'mini chopper blender',
  'chopper',
  'electric chopper',
  'Chopper',
  'my chopper is not working',
  'trutrtl chopper grinder 300w',
  'vegetable chopper',
];

// The two SKUs the live node carries, and the one SKU a mis-ordered rule would file instead.
const CHOPPER_SKUS = ['Trutrtl-Smart-Chopper-Black', 'Trutrtl-Smart-Chopper-Pink'];
const CHOPPER_DEFAULT_SKU = 'Trutrtl-Smart-Chopper-Black';
const MIXER_SKU = 'Trutrtl-Nutri-Insta-2Jar';

test('⭐ M-12: every chopper phrasing is an Electric Chopper — never a Mixer Grinder', () => {
  for (const said of CHOPPER_PHRASINGS) {
    const product = mapProduct(said);
    assert.equal(
      product, 'Electric Chopper',
      `"${said}" → ${product}. The chopper rule has moved BELOW the mixer rule in `
      + 'product-map.js RULES (first match wins) — chopper complaints are being tagged as '
      + 'Mixer Grinder again. Put [/\\bchopper\\b/i, \'Electric Chopper\'] back above it.',
    );
    assert.notEqual(product, 'Mixer Grinder', `"${said}" must never map to Mixer Grinder`);

    // ⭐ THE SAME ASSERTION ON THE OTHER VOCABULARY — and this is the one that now decides
    // what ops sees, because nothing downstream vetoes a wrong category any more.
    const category = mapCategory(said);
    assert.equal(
      category, 'Electric chopper',
      `"${said}" → ${category}. The chopper rule has moved BELOW the mixer rule in `
      + 'product-map.js CATEGORY_RULES (first match wins). Since M-12 the chopper is FILABLE, '
      + 'so nothing catches this any more: the complaint becomes a real Mixer Grinder ticket '
      + 'against a product the caller does not own. Put '
      + '[/\\bchopper\\b/i, \'Electric chopper\'] back above the mixer rule.',
    );
    assert.notEqual(category, 'Mixer Grinder', `"${said}" must never map to Mixer Grinder`);

    const sku = mapSku(category);
    assert.ok(CHOPPER_SKUS.includes(sku), `"${said}" → ${sku}, which is not a chopper SKU`);
    assert.notEqual(
      sku, MIXER_SKU,
      `"${said}" resolved to the mixer SKU — ops schedules technicians off cf_product`,
    );
  }
});

test('⭐ M-12: a chopper FILES now — and one payload pins BOTH casings', () => {
  for (const said of CHOPPER_PHRASINGS) {
    const v = validateComplaint({ product: said, platform: 'amazon' });
    assert.equal(
      v.ok, true,
      `"${said}" → ${v.code}. The desk admin created the 'Electric chopper' node on `
      + '2026-07-18, so a chopper is a normal filable product: no terminal callback, no '
      + 're-ask loop, a real ticket.',
    );

    const f = requiredCustomFields({ product: said, platform: 'amazon' });
    // ⚠ THE TRAP, PINNED. Capital C on the flat dropdown, lowercase c on the brand tree —
    // two different fields, two different option lists, both verified live. If these two
    // ever hold the same string, someone has "tidied" one vocabulary into the other and the
    // create 400s on the field that did not own that spelling.
    assert.equal(
      f.cf_custom_tags, 'Electric Chopper',
      `"${said}" → cf_custom_tags must be 'Electric Chopper' (CAPITAL C) — the flat product `
      + 'dropdown. The cf_product_category spelling is not a legal value here.',
    );
    assert.equal(
      f.cf_product_category, 'Electric chopper',
      `"${said}" → cf_product_category must be 'Electric chopper' (LOWERCASE c) — level 2 of `
      + 'the brand tree. The cf_custom_tags spelling is not a legal value here.',
    );
    assert.notEqual(
      f.cf_custom_tags, f.cf_product_category,
      `"${said}" wrote the SAME string to both fields. They are different fields with `
      + 'different option lists; one of the two is now illegal and the create 400s.',
    );
    assert.equal(f.cf_product, CHOPPER_DEFAULT_SKU, `"${said}" → default cf_product`);
    assert.notEqual(f.cf_product, MIXER_SKU, `"${said}" must never carry the mixer SKU`);
  }

  // Neither vocabulary contains the other's spelling — asserted on the lists themselves, so
  // a "consistency" edit to either constant fails here before it can reach a payload.
  assert.ok(FRESHDESK_PRODUCT_TAGS.includes('Electric Chopper'), 'capital C is the tag value');
  assert.equal(
    FRESHDESK_PRODUCT_TAGS.includes('Electric chopper'), false,
    "'Electric chopper' (lowercase c) is the CATEGORY spelling — it is not a cf_custom_tags choice",
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(TRUTRTL_CATEGORIES, 'Electric chopper'),
    'lowercase c is the category key',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(TRUTRTL_CATEGORIES, 'Electric Chopper'), false,
    "'Electric Chopper' (capital C) is the TAG spelling — it is not a cf_product_category value",
  );
  // And each mapper answers in ITS OWN vocabulary even when fed the other's string, so a
  // value that has been through one mapper can never arrive verbatim at the other field.
  assert.equal(mapProduct('Electric chopper'), 'Electric Chopper');
  assert.equal(mapCategory('Electric Chopper'), 'Electric chopper');
});

test('⭐ M-12: the chopper has LEFT both refusal lists — with real SKUs behind it', () => {
  for (const name of ['Chopper', 'Electric Chopper', 'Electric chopper']) {
    assert.equal(
      RECOGNISED_ONLY_PRODUCTS.includes(name), false,
      `${name} is recognise-only again — it has a live cf_custom_tags value and a live node, `
      + 'so listing it here would refuse a ticket we can file today.',
    );
    assert.equal(
      CATEGORY_UNAVAILABLE_PRODUCTS.includes(name), false,
      `${name} is back on the TERMINAL list — a chopper caller would get a callback promise `
      + 'and no ticket on a product truTRTL now files normally.',
    );
    assert.equal(isProductUnfilable(name), false, `${name} must not be unfilable`);
    assert.equal(isMappingPending(name), false, `${name} is decided, not pending`);
  }
  assert.equal(isCategoryAvailable('Electric Chopper'), true);
  assert.equal(isCategoryAvailable('Electric chopper'), true);

  // The live SKUs, byte-for-byte. Black is the documented default.
  assert.deepEqual(TRUTRTL_CATEGORIES['Electric chopper'], CHOPPER_SKUS);
  assert.deepEqual(
    matchSku('Electric chopper', 'pink'),
    { sku: 'Trutrtl-Smart-Chopper-Pink', matched: true },
  );
  assert.deepEqual(
    matchSku('Electric chopper', 'black'),
    { sku: CHOPPER_DEFAULT_SKU, matched: true },
  );
  // Silence, or a model token the tree has no SKU for, defaults to Black and SAYS it
  // defaulted — the description prints that, so ops never reads a guess as a confirmation.
  assert.deepEqual(matchSku('Electric chopper'), { sku: CHOPPER_DEFAULT_SKU, matched: false });
  assert.deepEqual(matchSku('Electric chopper', '300w'), { sku: CHOPPER_DEFAULT_SKU, matched: false });
});

test('⭐ M-12: precedence — the rule ORDER is the only thing left guarding the mixer', () => {
  // WHAT CHANGED: this test used to prove the opposite — that CATEGORY_RULES claimed the
  // compound phrasings for Mixer Grinder and LOST anyway, because isProductUnfilable()
  // overruled it in ticket-fields.js. That veto is gone with the chopper's node, so the
  // ordering itself is now load-bearing, in BOTH lists, with no second net underneath.
  const COMPOUND = ['chopper grinder', 'chopper cum grinder', 'chopper mixer', 'mini chopper blender'];
  for (const said of COMPOUND) {
    assert.equal(mapProduct(said), 'Electric Chopper', `"${said}" tag`);
    assert.equal(mapCategory(said), 'Electric chopper', `"${said}" category`);
    const f = requiredCustomFields({ product: said, platform: 'amazon' });
    assert.equal(f.cf_product_category, 'Electric chopper', `"${said}" payload category`);
    assert.equal(f.cf_custom_tags, 'Electric Chopper', `"${said}" payload tag`);
    assert.equal(
      f.cf_product, CHOPPER_DEFAULT_SKU,
      `"${said}" payload SKU — ${MIXER_SKU} here is a real ticket against the wrong product`,
    );
    assert.notEqual(f.cf_product, MIXER_SKU);
  }

  // The mixer itself is untouched: a real Mixer Grinder complaint still files, with the
  // real SKU. Keeping the chopper off the mixer must not cost truTRTL a mixer ticket.
  const f = requiredCustomFields({ product: 'mixer grinder', platform: 'amazon' });
  assert.equal(f.cf_product_category, 'Mixer Grinder');
  assert.equal(f.cf_product, MIXER_SKU);
  assert.equal(f.cf_custom_tags, 'Mixer Grinder');
  for (const said of ['mixer', 'grinder', 'juicer mixer', 'nutri blender', 'blender']) {
    assert.equal(mapProduct(said), 'Mixer Grinder', `"${said}" is still a mixer`);
    assert.equal(mapCategory(said), 'Mixer Grinder', `"${said}" is still a mixer category`);
    assert.equal(validateComplaint({ product: said, platform: 'amazon' }).ok, true);
  }
});

test('⭐ M-12: SOURCE ORDER — the chopper rule sits ABOVE the mixer rule in BOTH lists', () => {
  // A tripwire on the CAUSE rather than the symptom. The assertions above already fail if
  // the rules are reordered, but they report "chopper grinder became a Mixer Grinder"; this
  // one names the line that has to move back, which is what the person reading the failure
  // actually needs. If product-map.js is ever restructured, update this test deliberately —
  // do not delete it without moving the guarantee somewhere else.
  const src = readFileSync(new URL('../../src/lib/product-map.js', import.meta.url), 'utf8');
  const CHOPPER_RE = '/\\bchopper\\b/i';
  const MIXER_RE = '/\\b(mixer|grinder|juicer|blender)\\b/i,';

  for (const name of ['RULES', 'CATEGORY_RULES']) {
    const start = src.indexOf(`const ${name} = [`);
    assert.notEqual(start, -1, `${name} not found in product-map.js — this tripwire needs updating`);
    const end = src.indexOf('\n];', start);
    assert.notEqual(end, -1, `${name} has no closing bracket — this tripwire needs updating`);
    const block = src.slice(start, end);

    const chopper = block.indexOf(CHOPPER_RE);
    const mixer = block.indexOf(MIXER_RE);
    assert.notEqual(chopper, -1, `${name} has no chopper rule — a chopper cannot be filed at all`);
    assert.notEqual(mixer, -1, `${name} has no mixer rule — this tripwire needs updating`);
    assert.ok(
      chopper < mixer,
      `${name}: the chopper rule is BELOW the mixer rule. Both lists are first-match-wins, `
      + 'and "chopper grinder" / "chopper cum grinder" / "chopper mixer" / "mini chopper '
      + 'blender" all match the mixer regex, so every one of them now files as Mixer Grinder '
      + `/ ${MIXER_SKU} — a real, confident, wrong ticket. Move the chopper rule back above it.`,
    );
  }
});

// ── M-6: products the KB says we service that used to map to NOTHING ────────────────

test('⭐ M-6: "toaster" maps at last — and a "sandwich toaster" is still a Sandwich Maker', () => {
  // /\btoast\b/ never matched "toaster" (the trailing "er" kills the word boundary), so a
  // toaster complaint fell through every rule and came back as unknown_product.
  for (const said of ['toaster', 'Toaster', 'pop up toaster', 'my toaster is broken']) {
    assert.equal(mapProduct(said), 'Toaster', `"${said}" → Toaster`);
    // No node in the tree, no cf_custom_tags value: honest refusal, not a guess at
    // 'Toast-Sandwich Maker'. [CONFIRM: ops — Toaster → Sandwich Maker, or its own node?]
    assert.equal(mapCategory(said), null, `"${said}" must not borrow a category`);
    // ⭐ RECOVERABLE, not terminal. See the dedicated test below — this is the code that
    // decides whether Tara re-asks or hangs up on the complaint with a callback promise.
    assert.equal(
      validateComplaint({ product: said, platform: 'amazon' }).code, 'unknown_product',
    );
  }
  // The toaster rule sits BELOW the sandwich rule precisely so these keep filing.
  for (const said of ['sandwich toaster', 'grill toaster', 'toast maker', '3 in 1 sandwich maker']) {
    assert.equal(mapProduct(said), 'Sandwich Maker', `"${said}" → Sandwich Maker`);
    assert.equal(validateComplaint({ product: said, platform: 'amazon' }).ok, true, `"${said}" stays filable`);
  }
});

test('⭐ M-6: "boiler" / "water boiler" map — without stealing the egg boiler', () => {
  for (const said of ['boiler', 'water boiler', 'my water boiler stopped working', 'Water Boiler']) {
    assert.equal(mapProduct(said), 'Water Boiler', `"${said}" → Water Boiler`);
    // The KB names this product but carries no SKU, spec or warranty for it, so there is
    // nothing correct to file — but it is not the end of the road either: "water boiler" is
    // very common Indian English for an electric KETTLE, which we file every day. So the
    // verdict is RECOVERABLE (Tara asks which product it is), never a Kettle guess and never
    // a terminal callback. [CONFIRM: ops — where should a real water boiler file?]
    assert.equal(validateComplaint({ product: said, platform: 'amazon' }).code, 'unknown_product');
  }
  // The egg rule is ABOVE the boiler rule, and must stay there.
  for (const said of ['egg boiler', 'egg boiler 7 egg', '14 egg boiler', 'egg cooker']) {
    assert.equal(mapProduct(said), 'Egg boiler', `"${said}" → Egg boiler (singular b)`);
    assert.equal(mapCategory(said), 'Egg Boilers', `"${said}" → Egg Boilers (plural)`);
  }
  const f = requiredCustomFields({ product: 'egg boiler 7 egg', platform: 'amazon' });
  assert.equal(f.cf_product_category, 'Egg Boilers');
  assert.equal(f.cf_product, '7Egg Plastic - White');
  // A kettle is still a kettle: the kettle rule is above the boiler rule too.
  assert.equal(mapProduct('electric water boiler kettle'), 'Kettle');
});

// ── ⭐ TERMINAL vs RECOVERABLE — the regression that cost real tickets ───────────────

// Phrasings a caller actually uses for the two products whose mapping is still an open
// [CONFIRM]. "water boiler" is the important one: in Indian English it very often means an
// electric KETTLE, a product truTRTL sells and files every day.
const PENDING_PHRASINGS = [
  'toaster', 'Toaster', 'pop up toaster', 'my toaster is broken', '2 slice toaster',
  'boiler', 'water boiler', 'Water Boiler', 'my water boiler stopped working',
];

test('⭐ M-6 FIX: Toaster and Water Boiler are RECOVERABLE, never terminal', () => {
  // WHAT WENT WRONG: they were put on CATEGORY_UNAVAILABLE_PRODUCTS, whose code
  // (`category_unavailable`) register-complaint.js treats as TERMINAL — Tara stops asking,
  // promises a callback, and no ticket exists. That exceeded the plan (M-6 asked for the
  // mapping repair plus a [CONFIRM], not a refusal) and it cost tickets on both products:
  // a kettle owner who says "water boiler" was refused outright, and "my toaster is broken"
  // — which used to come back recoverable, so a caller who then said "sandwich toaster" WAS
  // filed — became a callback. The KB assumes the opposite: §10.C lists both under "STOP
  // USING IT AND REGISTER NOW" and §5 keeps video-framing rows for both.
  assert.deepEqual(PENDING_MAPPING_PRODUCTS, ['Toaster', 'Water Boiler']);
  for (const p of PENDING_MAPPING_PRODUCTS) {
    assert.equal(isMappingPending(p), true);
    assert.equal(
      isProductUnfilable(p), false,
      `${p} is back on CATEGORY_UNAVAILABLE_PRODUCTS — that makes it TERMINAL again, and a `
      + 'caller whose "water boiler" is really a kettle gets no ticket at all.',
    );
    assert.equal(isCategoryAvailable(p), false, `${p} still has no node — never guess one`);
  }
  // Case and whitespace are the caller's, not ours.
  assert.equal(isMappingPending('  water boiler  '), true);
  assert.equal(isMappingPending('TOASTER'), true);
  assert.equal(isMappingPending('Chopper'), false);
  assert.equal(isMappingPending('Ceiling Fan'), false);
  assert.equal(isMappingPending(null), false);

  for (const said of PENDING_PHRASINGS) {
    const v = validateComplaint({ product: said, platform: 'amazon' });
    assert.equal(v.ok, false, `"${said}" still cannot be filed as-is`);
    assert.equal(
      v.code, 'unknown_product',
      `"${said}" → ${v.code}. unknown_product is RECOVERABLE (register-complaint.js maps it `
      + 'to unmapped_product, which is NOT in its TERMINAL set), so Tara re-asks and the '
      + 'caller\'s next answer can still file. category_unavailable ends the complaint.',
    );
    // …and it is still never guessed into a borrowed category.
    assert.throws(
      () => requiredCustomFields({ product: said, platform: 'amazon' }),
      (e) => e instanceof TicketFieldError && e.code === 'unknown_product',
      `"${said}" must refuse to build a payload`,
    );
  }
});

test('⭐ M-6 FIX: Induction / Cooker / Iron are STILL terminal — the chopper is not', () => {
  // The other half of the fix: making two products recoverable must not soften the ones
  // that are genuinely blocked on an admin. Re-asking cannot help there — Tara has no legal
  // value to give — so a re-ask loop would be worse than the honest callback.
  // ⭐ M-12: the list is now THREE. 'Chopper' left it because the admin created the node —
  // that is the "TO ENABLE ONE" path in product-map.js, walked for real. Induction / Cooker /
  // Iron are still here: MILTON has those categories under cf_brand121540, truTRTL does not.
  // ⭐⭐ 2026-07-20 — AND THEY ARE NOW HERE PERMANENTLY. F-3 asked the desk admin to add the
  // three nodes, conditional on Manish confirming truTRTL still sold them. He confirmed the
  // opposite: "truTRTL does not sell Induction Cooktops, Pressure Cookers, or Irons. These
  // products are not part of our current product range." F-3 is withdrawn. So this list must
  // not shrink — a node for any of the three would make a product truTRTL does not sell
  // filable against a SKU that does not exist. It must not GROW into the tag list either:
  // all three stay in FRESHDESK_PRODUCT_TAGS and in Tara's enum, because recognising the
  // product is what lets us decline honestly (removing the enum value forces the model to
  // send the nearest legal one — the M-1 chopper defect rebuilt).
  assert.deepEqual(CATEGORY_UNAVAILABLE_PRODUCTS, ['Induction', 'Cooker', 'Iron']);
  for (const p of ['Induction', 'Cooker', 'Iron']) {
    assert.ok(
      FRESHDESK_PRODUCT_TAGS.includes(p),
      `${p} was removed from cf_custom_tags. It is a LIVE value on a SHARED dropdown (MILTON `
      + 'sells all three) and removing it here does not stop the caller owning one — it just '
      + 'stops us recognising what they said, and the model then sends the nearest legal '
      + 'value instead. Recognise, then decline.',
    );
  }
  for (const p of ['Induction', 'Cooker', 'Iron']) {
    assert.equal(isProductUnfilable(p), true, `${p} MUST stay terminal`);
    assert.equal(isMappingPending(p), false, `${p} must not become recoverable`);
    assert.equal(
      validateComplaint({ product: p, platform: 'amazon' }).code, 'category_unavailable',
      `${p} must keep the TERMINAL verdict — ops picks it up from the UNFILED log`,
    );
  }
  // The compound phrasings that made each one dangerous are terminal too. (These match the
  // broad stove rule in CATEGORY_RULES, so a non-null category is NOT permission to file.)
  for (const said of ['induction stove', 'cooker hob', 'steam iron']) {
    assert.equal(validateComplaint({ product: said, platform: 'amazon' }).code, 'category_unavailable');
  }
  // …and the chopper phrasing that used to sit in that list files a real ticket now.
  assert.equal(
    validateComplaint({ product: 'chopper grinder', platform: 'amazon' }).ok, true,
    'a chopper is filable since M-12 — a terminal verdict here loses a ticket we can create',
  );

  // Enabling one product must not sweep the RECOVERABLE two along with it: Toaster and
  // Water Boiler are still waiting on a [CONFIRM], not on a node, so Tara still re-asks.
  for (const p of ['Toaster', 'Water Boiler']) {
    assert.equal(isProductUnfilable(p), false, `${p} must not become terminal`);
    assert.equal(isMappingPending(p), true, `${p} is still an open [CONFIRM]`);
    assert.equal(
      validateComplaint({ product: p, platform: 'amazon' }).code, 'unknown_product',
      `${p} must stay RECOVERABLE — a "water boiler" is very often an electric kettle`,
    );
  }
});

test('⭐ 2026-07-20: a legacy GAS STOVE still files — withdrawn from sale ≠ unfilable', () => {
  // THE DECISION THIS TEST PINS. Manish confirmed truTRTL does not sell gas stoves and holds
  // no documentation, troubleshooting guide or fault list for them. That answer was given to
  // a PRE-SALES question ("do you offer…?", "can you provide the fault list?"), and it has
  // been applied where it belongs: the KB names no gas stove in any "what we sell" answer and
  // still carries zero gas-stove product content.
  //
  // It was NOT an answer about service, and the filing path is deliberately left open. The
  // 'Gas Stoves' category and its three Shakti SKUs are live under the truTRTL brand
  // (verified 2026-07-18), which is evidence that someone at truTRTL provisioned them. A
  // caller who already owns one therefore gets a real ticket on the right node, from their
  // own words — not the terminal callback, which produces no ticket and no complaint number
  // and leaves a customer with a GAS appliance recorded only in a log file.
  //
  // If this test fails because someone added 'Gas Stove' to CATEGORY_UNAVAILABLE_PRODUCTS:
  // that is a real decision someone may legitimately take, but it needs F-6 (desk owner) or
  // Manish to say so first — not an inference from a pre-sales answer. Change it
  // deliberately, with the answer quoted, or put it back.
  assert.equal(isProductUnfilable('Gas Stove'), false, 'a stove owner must not hit the callback');
  for (const said of ['gas stove', 'Gas Stove', 'my gas stove burner is not lighting', 'the hob']) {
    assert.equal(
      validateComplaint({ product: said, platform: 'amazon' }).ok, true,
      `"${said}" was refused — a legacy stove owner now gets a callback promise and no ticket`,
    );
  }
  assert.equal(mapProduct('gas stove'), 'Gas Stove');
  assert.equal(mapCategory('gas stove'), 'Gas Stoves');
  const f = requiredCustomFields({ product: 'gas stove', platform: 'amazon' });
  assert.equal(f.cf_custom_tags, 'Gas Stove', 'singular on the flat dropdown');
  assert.equal(f.cf_product_category, 'Gas Stoves', 'plural on the brand tree');
  assert.equal(f.cf_product, 'Shakti 2B', 'the live default SKU');
  assert.deepEqual(TRUTRTL_CATEGORIES['Gas Stoves'], ['Shakti 2B', 'Shakti 3B', 'Shakti 4B']);
  assert.deepEqual(matchSku('Gas Stoves', '4b'), { sku: 'Shakti 4B', matched: true });

  // ⚠ AND THE HALF THAT MUST NOT LEAK. Keeping the stove node alive keeps the loose stove
  // regex alive with it, so the precedence in validateComplaint() is the ONLY thing stopping
  // an induction being filed as a Shakti. Asserted here, next to the decision that makes it
  // load-bearing, and not only in the terminal test above.
  for (const said of ['induction stove', 'induction cooktop', 'induction hob', 'cooker hob']) {
    assert.equal(mapCategory(said), 'Gas Stoves', `"${said}" is only interesting while it collides`);
    assert.equal(
      validateComplaint({ product: said, platform: 'amazon' }).code, 'category_unavailable',
      `"${said}" must be refused. A non-null gas-stove category is NOT permission to file — `
      + 'isProductUnfilable() has to be asked FIRST, or a broken induction becomes a Shakti 2B '
      + 'ticket and ops sends a stove technician.',
    );
  }
});

test('⭐ M-6 FIX: a recognise-only product never escapes through a borrowed category', () => {
  // The recoverable check must sit ABOVE the `!category` branch in validateComplaint(),
  // because the two vocabularies are matched INDEPENDENTLY and the category one is looser.
  // Each phrasing below is a Toaster / Water Boiler to mapProduct() and something filable to
  // mapCategory() — decide lower down and the ticket gets that borrowed category plus
  // 'Toaster' written to cf_custom_tags, which is not a dropdown value and 400s the create.
  const COLLIDING = [
    ['toaster mixer', 'Toaster', 'Mixer Grinder'],
    ['water boiler fan noise', 'Water Boiler', 'Ceiling Fans'],
    ['toaster blender combo', 'Toaster', 'Mixer Grinder'],
  ];
  for (const [said, product, category] of COLLIDING) {
    assert.equal(mapProduct(said), product, `"${said}" → ${product}`);
    assert.equal(mapCategory(said), category, `"${said}" is only interesting while it collides`);
    assert.equal(
      validateComplaint({ product: said, platform: 'amazon' }).code, 'unknown_product',
      `"${said}" must be refused, not filed under ${category}`,
    );
    assert.throws(
      () => requiredCustomFields({ product: said, platform: 'amazon' }),
      TicketFieldError,
      `"${said}" must never build a payload carrying ${product} on cf_custom_tags`,
    );
  }
  // And the products those rules belong to are untouched.
  assert.equal(validateComplaint({ product: 'mixer grinder', platform: 'amazon' }).ok, true);
  assert.equal(validateComplaint({ product: 'ceiling fan', platform: 'amazon' }).ok, true);
  assert.equal(validateComplaint({ product: 'sandwich toaster', platform: 'amazon' }).ok, true);
});

test('⭐ M-6: the fan qualifier is required, and bare "fan" is LAST resort', () => {
  // Was: /\b(ceiling|pedestal|wall|table)?\s*fan\b/ at rule #2 — the qualifier was OPTIONAL,
  // so any sentence containing "fan" outranked every product named after it.
  assert.equal(mapProduct('the fan in my mixer grinder is stuck'), 'Mixer Grinder');
  assert.equal(mapProduct('air fryer fan noise'), 'Air fryer');
  assert.equal(mapProduct('kettle fan smell'), 'Kettle');

  // Explicit fans still map, in both vocabularies.
  for (const said of ['ceiling fan', '48 inch ceiling fan', 'table fan', 'pedestal fan', 'wall fan']) {
    assert.equal(mapProduct(said), 'Ceiling Fan', `"${said}" → Ceiling Fan (singular)`);
    assert.equal(mapCategory(said), 'Ceiling Fans', `"${said}" → Ceiling Fans (plural)`);
  }
  // A lone "fan" is still filable — Ceiling Fans is truTRTL's only fan category, so this is
  // the last-resort match rather than a fabrication. ⚠ It also swallows fan types truTRTL
  // does not sell ("exhaust fan"). [CONFIRM: ops — should an exhaust/tower fan be declined
  // instead?] Asserted as-is so a deliberate change here is a visible one.
  assert.equal(mapProduct('fan not working'), 'Ceiling Fan');
  assert.equal(mapCategory('fan not working'), 'Ceiling Fans');
  assert.equal(mapProduct('exhaust fan'), 'Ceiling Fan');

  const f = requiredCustomFields({ product: '48 inch ceiling fan', platform: 'amazon' });
  assert.equal(f.cf_product_category, 'Ceiling Fans');
  assert.equal(f.cf_product, 'Trutrtl-Smart-1200 MM');
});

// ── The live strings + the writability invariant ────────────────────────────────────

test('⭐ the 8 filable categories map to the EXACT live category and SKU', () => {
  // Freshdesk validates Brand→Category→SKU server-side and 400s an invalid triple, so every
  // character below is load-bearing: 'Multipurpose-1.3Kettle' has NO space where
  // 'Electric-1.5 Kettle' does, the air-fryer codes are parenthesised, 'Trutrtl-7Egg-Mrb'
  // is cased oddly. Never tidy them.
  const LIVE_CHAIN = [
    ['48 inch ceiling fan', 'Ceiling Fan', 'Ceiling Fans', 'Trutrtl-Smart-1200 MM'],
    ['my 1.5L kettle', 'Kettle', 'Kettle', 'Electric-1.5 Kettle'],
    ['egg boiler 7 egg', 'Egg boiler', 'Egg Boilers', '7Egg Plastic - White'],
    ['digital air fryer', 'Air fryer', 'Air fryer', 'Manual(KZ-4505 M)'],
    ['grill sandwich maker', 'Sandwich Maker', 'Sandwich Maker', 'Grill-Sandwich Maker'],
    ['mixer grinder', 'Mixer Grinder', 'Mixer Grinder', 'Trutrtl-Nutri-Insta-2Jar'],
    ['gas stove', 'Gas Stove', 'Gas Stoves', 'Shakti 2B'],
    // ⭐ M-12 — the EIGHTH category, added live by the desk admin on 2026-07-18 and read
    // back from GET /api/v2/ticket_fields. Note the casing pair: 'Electric Chopper' on the
    // flat dropdown, 'Electric chopper' on the brand tree.
    ['chopper grinder', 'Electric Chopper', 'Electric chopper', 'Trutrtl-Smart-Chopper-Black'],
  ];
  // EIGHT categories and 22 SKUs, verbatim. Adding a category without a LIVE_CHAIN row above
  // fails here rather than going untested.
  assert.deepEqual(Object.keys(TRUTRTL_CATEGORIES), [
    'Ceiling Fans', 'Kettle', 'Egg Boilers', 'Air fryer', 'Sandwich Maker',
    'Mixer Grinder', 'Gas Stoves', 'Electric chopper',
  ]);
  assert.equal(
    Object.values(TRUTRTL_CATEGORIES).flat().length, 22,
    'the live truTRTL tree carries 22 SKUs across its 8 categories',
  );
  assert.deepEqual(
    LIVE_CHAIN.map(([, , category]) => category).sort(),
    Object.keys(TRUTRTL_CATEGORIES).sort(),
    'every live category needs a row above — an untested category is one that can 400 silently',
  );
  for (const [said, tag, category, sku] of LIVE_CHAIN) {
    assert.equal(mapProduct(said), tag, `"${said}" → cf_custom_tags value`);
    assert.equal(mapCategory(said), category, `"${said}" → cf_product_category`);
    assert.equal(mapSku(category), sku, `${category} → default cf_product`);
    assert.ok(TRUTRTL_CATEGORIES[category].includes(sku), `${sku} is not a ${category} SKU`);
    const f = requiredCustomFields({ product: said, platform: 'amazon' });
    assert.equal(f.cf_product_category, category, `"${said}" payload category`);
    assert.equal(f.cf_product, sku, `"${said}" payload SKU`);
  }
  // The tag vocabulary is SINGULAR, the category vocabulary is PLURAL — and since M-12 they
  // also differ by CASE. Copying a string between them 400s the create either way; assert
  // every pair that differs, in both directions.
  assert.equal(mapProduct('ceiling fan'), 'Ceiling Fan');
  assert.equal(mapCategory('ceiling fan'), 'Ceiling Fans');
  assert.equal(mapProduct('gas stove'), 'Gas Stove');
  assert.equal(mapCategory('gas stove'), 'Gas Stoves');
  assert.equal(mapProduct('egg boiler'), 'Egg boiler');
  assert.equal(mapCategory('egg boiler'), 'Egg Boilers');
  // ⚠ The M-12 pair: same words, different capital. 'Electric Chopper' is ONLY legal on
  // cf_custom_tags; 'Electric chopper' is ONLY legal on cf_product_category.
  assert.equal(mapProduct('chopper'), 'Electric Chopper');
  assert.equal(mapCategory('chopper'), 'Electric chopper');
  assert.notEqual(mapProduct('chopper'), mapCategory('chopper'));
});

test('⭐ nothing recognise-only can ever reach the cf_custom_tags dropdown', () => {
  // The ELEVEN verified-live dropdown values, verbatim (casing included). 'Electric Chopper'
  // — capital C — was added live by the desk admin on 2026-07-18; the brand tree spells the
  // same product 'Electric chopper', and that difference is deliberate on both sides.
  assert.deepEqual(FRESHDESK_PRODUCT_TAGS, [
    'Gas Stove', 'Egg boiler', 'Induction', 'Iron', 'Sandwich Maker',
    'Ceiling Fan', 'Cooker', 'Kettle', 'Air fryer', 'Mixer Grinder', 'Electric Chopper',
  ]);
  // ⭐ M-12: 'Chopper' is gone from here — it is a real dropdown value with a real node now,
  // so it is filed, not declined.
  assert.deepEqual(RECOGNISED_ONLY_PRODUCTS, ['Toaster', 'Water Boiler']);

  // THE INVARIANT: mapProduct() may name a product Freshdesk has no value for — that is how
  // we decline honestly — but no such value may ever be WRITTEN, or M-3's cf_custom_tags
  // write would put an illegal string on a real ticket and 400 the create. Note what the
  // invariant is and is not: it is "the create is refused", NOT "the refusal is terminal".
  // Toaster and Water Boiler are refused RECOVERABLY (they are on PENDING_MAPPING_PRODUCTS);
  // asserting unfilability here is what pushed them onto the terminal list in the first place.
  for (const p of RECOGNISED_ONLY_PRODUCTS) {
    assert.equal(FRESHDESK_PRODUCT_TAGS.includes(p), false, `${p} is not a dropdown value`);
    assert.equal(mapCategory(p), null, `${p} must have no category`);
    assert.ok(
      isProductUnfilable(p) || isMappingPending(p),
      `${p} is recognise-only, so it must be on exactly one of the two refusal lists`,
    );
    assert.equal(
      isProductUnfilable(p) && isMappingPending(p), false,
      `${p} cannot be both terminal and recoverable — the route branches on one verdict`,
    );
    assert.throws(
      () => requiredCustomFields({ product: p, platform: 'amazon' }),
      TicketFieldError,
      `${p} must never build a payload — ${p} is not a legal cf_custom_tags value`,
    );
  }
  for (const p of PRODUCT_CHOICES) {
    assert.equal(mapProduct(p), p, `${p} must be idempotent`);
    assert.ok(
      FRESHDESK_PRODUCT_TAGS.includes(p) || isProductUnfilable(p) || isMappingPending(p),
      `${p} is neither a live dropdown value nor refused — it would 400 on create`,
    );
  }
  // Unrecognised text is still "ask the caller again", not "admin gap".
  assert.equal(mapProduct('dishwasher'), null);
  assert.equal(validateComplaint({ product: 'dishwasher', platform: 'amazon' }).code, 'unknown_product');
});
