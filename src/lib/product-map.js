// Map free-text product (what the caller says / what the LLM extracts) to the
// EXACT `cf_custom_tags` dropdown choice on digicart.freshdesk.com.
// If we can't confidently map it, return null and leave the field unset (the raw
// text still goes into the ticket description so nothing is lost).
//
// ⚠ TWO INDEPENDENT VOCABULARIES LIVE IN THIS FILE. They are NOT interchangeable:
//   1. cf_custom_tags   — the flat product dropdown. SINGULAR: 'Ceiling Fan',
//                         'Egg boiler', 'Gas Stove'. 11 values, all brands' products —
//                         FRESHDESK_PRODUCT_TAGS below. mapProduct() can also return a
//                         RECOGNISED_ONLY_PRODUCTS value (Chopper / Toaster / Water
//                         Boiler), which is NOT a dropdown value and must never be written
//                         to the field; none of the three can be filed today, so no payload
//                         is ever built for one — see the two lists below, which differ in
//                         WHY (a permanent admin gap vs an unanswered [CONFIRM]) and
//                         therefore in what Tara does next.
//   2. cf_brand121540   — 3-level nested: Brand → cf_product_category → cf_product(SKU).
//                         PLURAL: 'Ceiling Fans', 'Egg Boilers', 'Gas Stoves'. Freshdesk
//                         VALIDATES the chain, so an inconsistent triple 400s on create.
// truTRTL has EIGHT categories in tree 2 but ELEVEN products in tree 1 — the three-value
// gap is exactly Induction / Cooker / Iron, and as of 2026-07-20 that gap is PERMANENT and
// CORRECT (see CATEGORY_UNAVAILABLE_PRODUCTS below: the client has withdrawn all three from
// the range). Never copy a string from one vocabulary into the other.

// The ELEVEN verified-live `cf_custom_tags` dropdown values. VERBATIM, including the
// inconsistent casing Freshdesk actually has ('Egg boiler' and 'Air fryer' are sentence
// case, the rest Title Case). These are the ONLY values that may ever be written to
// cf_custom_tags — anything else is rejected by the dropdown.
export const FRESHDESK_PRODUCT_TAGS = [
  'Gas Stove', 'Egg boiler', 'Induction', 'Iron', 'Sandwich Maker',
  'Ceiling Fan', 'Cooker', 'Kettle', 'Air fryer', 'Mixer Grinder',
  // ⭐ M-12 (2026-07-18) — added live by the desk admin and VERIFIED against
  // GET /api/v2/ticket_fields on digicart.freshdesk.com. Capital C here.
  // ⚠ THE CASING DIFFERS FROM THE BRAND TREE: this dropdown says 'Electric Chopper',
  // cf_product_category says 'Electric chopper' (lowercase c). They are different fields
  // with different vocabularies — copying a string between them writes an illegal value
  // and the create 400s. This is the singular/plural trap in a new costume.
  'Electric Chopper',
];

// ⭐ RECOGNISE-ONLY products (M-1 / M-6). Real appliances callers name — the KB's own §3
// says we service them — that have NO cf_custom_tags value AND no node in the brand tree.
// We name them so we can DECLINE HONESTLY instead of silently answering with the nearest
// legal-looking value: none of them can reach Freshdesk, because validateComplaint() in
// ticket-fields.js refuses EVERY value on this list before a payload is built — on one of
// the two lists below, which decide only what Tara does next.
//
//   Chopper      — Tara's Ravan enum has no chopper and no "Other", so she is FORCED to
//                  send the nearest legal value ('Mixer Grinder'), and the mixer rule
//                  below then agreed with her: "chopper grinder" filed a CONFIDENT, VALID,
//                  COMPLETELY WRONG Mixer Grinder / 'Trutrtl-Nutri-Insta-2Jar' ticket that
//                  ops dispatched a technician from, while Tara read back its number.
//                  TERMINAL — see CATEGORY_UNAVAILABLE_PRODUCTS below.
//   Toaster      — a pop-up toaster is not a sandwich maker. [CONFIRM: ops — does Toaster
//                  map to Sandwich Maker, or does it need its own node?] Until answered,
//                  filing one as 'Toast-Sandwich Maker' would fabricate the model.
//   Water Boiler — the KB lists a "Water boiler / 'boiler' (Midea-sourced)" with no SKU,
//                  spec or warranty anywhere. [CONFIRM: ops — where should a water boiler
//                  file: its own node, or the Kettle tree?] "Water boiler" is also very
//                  common Indian English for an electric KETTLE, which truTRTL does sell
//                  and can file today.
// ⭐ M-12 (2026-07-18): 'Chopper' has LEFT this list. The desk admin created the node, so
// the chopper is now a fully filable product, not a recognised-but-unfilable one. It is a
// real FRESHDESK_PRODUCT_TAGS value with a real category and real SKUs below.
export const RECOGNISED_ONLY_PRODUCTS = ['Toaster', 'Water Boiler'];

// ⭐ THE RECOVERABLE HALF (fix to M-6). Recognise-only products whose mapping is UNDECIDED
// rather than impossible — they are waiting on the two [CONFIRM]s above, not on an admin
// creating a node nobody has asked for.
//
// The distinction is not cosmetic: register-complaint.js treats `category_unavailable` as
// TERMINAL (Tara stops asking, takes a callback, the complaint lives only in the UNFILED
// log) and `unknown_product` as RECOVERABLE (Tara re-asks, and the caller's next answer can
// file). Putting these two on CATEGORY_UNAVAILABLE_PRODUCTS made them terminal, which cost
// real tickets:
//   • "water boiler" is what a great many callers call their electric KETTLE. Terminal
//     refusal meant a kettle owner got a callback promise and no ticket, on a product we
//     file every day.
//   • "my toaster is broken" used to come back recoverable, Tara re-asked, and a caller who
//     then said "sandwich toaster" WAS filed as a Sandwich Maker. Terminal killed that.
// The KB agrees with recoverable: §10.C lists Toasters and Water boiler under "STOP USING
// IT AND REGISTER NOW", and §5 keeps video-framing rows for both — it documents tickets
// that must be creatable.
//
// Still never GUESSED: mapCategory() gives them no category, so ticket-fields.js declines
// to build a payload either way. The only thing that changes is what Tara says next.
// TO RESOLVE ONE: when ops answers, either add the category + SKUs to the tree (and drop it
// from RECOGNISED_ONLY_PRODUCTS + here), or move it to CATEGORY_UNAVAILABLE_PRODUCTS.
export const PENDING_MAPPING_PRODUCTS = ['Toaster', 'Water Boiler'];

const pendingMapping = new Set(PENDING_MAPPING_PRODUCTS.map((p) => p.toLowerCase()));

/**
 * Is this a recognised product whose mapping is merely UNDECIDED — i.e. is asking the
 * caller again worth doing? True only for PENDING_MAPPING_PRODUCTS; never for the
 * terminal ones, and never for text we don't recognise at all.
 * @param {string} productKey a mapProduct() result (or any free text)
 */
export function isMappingPending(productKey) {
  if (!productKey) return false;
  return pendingMapping.has(String(productKey).trim().toLowerCase());
}

// Everything mapProduct() can return. ⚠ Only the FRESHDESK_PRODUCT_TAGS half is writable to
// cf_custom_tags — see the guarded invariant in test/unit/product-map.test.js.
export const PRODUCT_CHOICES = [...FRESHDESK_PRODUCT_TAGS, ...RECOGNISED_ONLY_PRODUCTS];

// Ordered keyword → choice rules (FIRST MATCH WINS — the order below is load-bearing).
const RULES = [
  // ⭐ M-1 — THIS RULE MUST STAY ABOVE THE MIXER RULE. "chopper grinder", "chopper cum
  // grinder", "chopper mixer" and "mini chopper blender" all match
  // /\b(mixer|grinder|juicer|blender)\b/, so with the chopper rule below it a chopper
  // complaint became a Mixer Grinder ticket with the fabricated SKU
  // 'Trutrtl-Nutri-Insta-2Jar'. Moving this line down restores that silently — which is
  // why test/unit/product-map.test.js asserts the ordering directly.
  [/\bchopper\b/i, 'Electric Chopper'],
  [/\bair\s*fry/i, 'Air fryer'],
  // ⭐ M-6 (defect 12) — the qualifier used to be OPTIONAL (`(ceiling|…)?\s*fan`), so ANY
  // text containing "fan" became a Ceiling Fan from the SECOND rule onwards: "the fan in
  // my mixer grinder" and "air fryer fan noise" were filed as ceiling fans with the
  // fabricated model 'Trutrtl-Smart-1200 MM'. The qualifier is now REQUIRED here, and a
  // bare "fan" is a LAST-RESORT rule at the bottom of this list — so a named product
  // always wins, and a lone "fan" still maps (Ceiling Fans is truTRTL's only fan category).
  [/\b(ceiling|pedestal|wall|table)\s*fan\b/i, 'Ceiling Fan'],
  [/\bkettle\b/i, 'Kettle'],
  [/\begg\b/i, 'Egg boiler'],
  [/\b(sandwich|grill|toast|waffle)\b/i, 'Sandwich Maker'],
  // ⭐ M-6 — "toaster" matched NOTHING: /\btoast\b/ fails on the trailing "er". It sits
  // BELOW the sandwich rule on purpose: "sandwich toaster" is the common Indian-English
  // name for a Sandwich Maker (a filable product), so only a bare toaster falls through
  // to the honest-failure path.
  [/\btoaster\b/i, 'Toaster'],
  // ⭐ M-6 — "boiler" / "water boiler" matched nothing either. BELOW the egg rule, which
  // owns "egg boiler"; the KB uses a bare "boiler" for the Midea-sourced water boiler.
  [/\b(water\s*)?boiler\b/i, 'Water Boiler'],
  [/\b(mixer|grinder|juicer|blender)\b/i, 'Mixer Grinder'],
  [/\binduction\b/i, 'Induction'],
  [/\b(pressure\s*)?cooker\b/i, 'Cooker'],
  [/\b(gas\s*stove|stove|cooktop|hob)\b/i, 'Gas Stove'],
  [/\biron\b/i, 'Iron'],
  // LAST RESORT (M-6). Reached only when no named product matched. Keep it last.
  [/\bfan\b/i, 'Ceiling Fan'],
];

export function mapProduct(text) {
  if (!text) return null;
  const t = String(text).trim();
  // Exact (case-insensitive) match to a known choice.
  const exact = PRODUCT_CHOICES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  for (const [re, choice] of RULES) if (re.test(t)) return choice;
  return null;
}

// ── Brand nested chain: cf_product_category (level 2) + cf_product / SKU (level 3) ──
// These are the EXACT truTRTL values on digicart.freshdesk.com (verified live).
// VERBATIM — including the irregular spacing ('Multipurpose-1.3Kettle' has no space,
// 'Electric-1.5 Kettle' does), the parenthesised air-fryer codes and 'Trutrtl-7Egg-Mrb'
// casing. Do not tidy them: a single wrong character 400s the create.
export const TRUTRTL_CATEGORIES = {
  'Ceiling Fans': ['Trutrtl-Smart-1200 MM', 'Trutrtl-Wave-600 MM', 'Trutrtl-Ultra-1200 MM'],
  Kettle: ['Multipurpose-1.3Kettle', 'Electric-1.5 Kettle'],
  'Egg Boilers': ['7Egg Plastic - White', '7Egg Plastic - Black', '14Egg Plastic - Black', 'Trutrtl-7Egg-Mrb'],
  'Air fryer': ['Digital(KZ-4505 A1)', 'Manual(KZ-4505 M)', 'Trutrtl-Airfryer-12L'],
  'Sandwich Maker': ['Toast-Sandwich Maker', 'Grill-Sandwich Maker', '3-in-1 Sandwich Maker'],
  'Mixer Grinder': ['Trutrtl-Nutri-Insta-2Jar', 'Trutrtl-Nutri-Insta-3Jar'],
  // ⚠ DELIBERATELY RETAINED — DO NOT "TIDY" THIS AWAY. On 2026-07-20 Manish answered:
  // "At present, truTRTL does not manufacture or sell Gas Stoves. Therefore, we do not have
  // any product documentation, troubleshooting guide, or common fault list for Gas Stoves."
  // That is a PRE-SALES answer, and it has been applied where it belongs: the KB no longer
  // names gas stoves in any "what we sell" / "where to buy" answer and still holds ZERO
  // gas-stove product content (no specs, no faults, no warranty — §3.8 is a deliberate
  // blank). It is NOT a service answer, and it was never asked as one.
  //
  // These three SKUs are live under the truTRTL brand on digicart.freshdesk.com (verified
  // 2026-07-18 via GET /api/v2/ticket_fields) — someone at truTRTL provisioned them, which
  // is hard evidence that stoves were sold at some point. So the FILING path stays open: a
  // caller who already owns one gets a real ticket, from their own words, on the right node.
  // Deleting this entry would move them onto the terminal `category_unavailable` callback —
  // no ticket, no complaint number, a record that survives only in the UNFILED log — on an
  // inference the client did not make. Being wrong this way costs a ticket; being wrong the
  // other way costs a customer with a GAS appliance and no record of their complaint.
  // Open with the desk owner as F-6 (were these ever sold? should the node stay?) and with
  // Manish (should legacy owners still be serviced?). Retire it only when one of them says so.
  'Gas Stoves': ['Shakti 2B', 'Shakti 3B', 'Shakti 4B'],
  // ⭐ M-12 (2026-07-18). Read live from GET /api/v2/ticket_fields, byte-for-byte.
  // ⚠ 'Electric chopper' — LOWERCASE c. The cf_custom_tags value is 'Electric Chopper'
  // with a capital C. Do not "tidy" either one into agreement; they are two different
  // fields and Freshdesk validates each against its own option list.
  'Electric chopper': ['Trutrtl-Smart-Chopper-Black', 'Trutrtl-Smart-Chopper-Pink'],
};

// Products a caller can NAME that have no node in the 8-category brand tree above. There is
// no valid Brand→Category→SKU triple for them, so Freshdesk would REJECT the create — and
// re-asking the caller cannot help, which is what makes this list the TERMINAL one.
//   • Induction / Cooker / Iron — IN the cf_custom_tags dropdown (they are shared with
//     MILTON, which does sell them) and in Tara's enum, with no truTRTL node behind them.
//     ⭐ As of 2026-07-20 these are also products truTRTL DOES NOT SELL — see the settled-
//     policy note at the bottom of this comment. The refusal is the right answer, not a gap.
//
// ⚠ Toaster and Water Boiler are deliberately NOT here. They are recognise-only too, but
// their mapping is an unanswered [CONFIRM] rather than a missing node, so they take the
// RECOVERABLE path (PENDING_MAPPING_PRODUCTS above) — Tara re-asks, and "sandwich toaster"
// or "kettle" still files. Adding them back makes a kettle owner who says "water boiler"
// unfilable on a product truTRTL sells; that regression is what this comment exists to stop.
//
// This is §9.1 #2, verified live: `mapCategory('Induction')` is null, and the old
// `|| 'Ceiling Fans'` fallback then filed the complaint as a CEILING FAN with the
// fabricated model 'Trutrtl-Smart-1200 MM' (identically for Cooker and Iron). Ops routes
// and schedules technicians off those two fields. 3 of the 10 values Tara is told to send
// hit it — the comment claiming "Ravan enum prevents this" was exactly backwards; the
// documented enum is what TRIGGERS it.
//
// Listed EXPLICITLY rather than inferred from a missing CATEGORY_RULES rule, so that a
// typo'd or deleted rule can never quietly reclassify a filable product as "unavailable"
// (or vice versa). We still recognise these products — knowing what the caller said is
// what lets us decline honestly instead of misfiling — but ticket-fields.js refuses to
// build a payload for them.
//
// TO ENABLE ONE: once an admin adds the category + its SKUs to cf_brand121540, add the
// category to TRUTRTL_CATEGORIES (+ a DEFAULT_SKU entry) and a CATEGORY_RULES rule, then
// drop the product from this list. Nothing else anywhere needs to change.
// ⚠ Induction, Cooker and Iron are NOT candidates for that path — see below. Do not build
// tree nodes for them; the honest refusal IS the correct behaviour for all three.
// ⭐ M-12 (2026-07-18): 'Chopper' REMOVED — the admin created 'Electric chopper' with two
// SKUs, so it now files normally. This is the "TO ENABLE ONE" path above, walked for real:
// tree entry + DEFAULT_SKU + CATEGORY_RULES rule added, product dropped from this list.
//
// ⭐⭐ SETTLED POLICY, 2026-07-20 — THIS IS NO LONGER A PENDING GAP. F-3 asked the desk
// owner to ADD Induction / Cooker / Iron nodes, on the prerequisite that Manish first
// confirm truTRTL still sold them. That prerequisite came back NEGATIVE. Verbatim:
//   "At present, truTRTL does not sell Induction Cooktops, Pressure Cookers, or Irons.
//    These products are not part of our current product range."
//   "Do not provide any information about Gas Stoves, Induction Cooktops, Pressure Cookers,
//    or Irons... We will add them later if we launch them."
// So F-3 has been WITHDRAWN (the correct admin action is retire, not add) and this list is
// now PERMANENTLY CORRECT rather than a stopgap awaiting configuration. Three consequences
// for whoever reads this next:
//   1. Do NOT add tree nodes for these three. A node would make a product truTRTL does not
//      sell filable again, and would file it against a SKU that does not exist.
//   2. Do NOT remove them from FRESHDESK_PRODUCT_TAGS or from Tara's Ravan enum. That
//      dropdown is SHARED — MILTON sells all three — and recognising what the caller owns
//      is precisely what lets us decline honestly. An enum without the value forces the
//      model to send the NEAREST LEGAL value instead, which is the M-1 chopper defect
//      (a confident, valid, completely wrong ticket) rebuilt from scratch.
//   3. This list stays THREE until truTRTL launches one of them. If that ever happens it is
//      a fresh F-1-shaped request, not the resurrection of F-3.
export const CATEGORY_UNAVAILABLE_PRODUCTS = [
  'Induction', 'Cooker', 'Iron',
];

const categoryUnavailable = new Set(CATEGORY_UNAVAILABLE_PRODUCTS.map((p) => p.toLowerCase()));

/**
 * Is this an explicitly UNFILABLE product — recognised, real, and with no node in the
 * brand tree? Answers only from the list above; it never consults CATEGORY_RULES.
 *
 * ⭐ Exported because the two vocabularies are matched INDEPENDENTLY, and the category
 * vocabulary is the looser of the two: /\b(gas\s*stove|stove|cooktop|hob)\b/ below happily
 * claims "induction stove" for Gas Stoves. Callers must be able to ask "is this product
 * filable at all?" WITHOUT that answer being coloured by what mapCategory() thinks it saw
 * — see validateComplaint() in ticket-fields.js, where asking in the wrong order filed
 * inductions as gas stoves.
 * @param {string} productKey a cf_custom_tags value (or any free text)
 */
export function isProductUnfilable(productKey) {
  if (!productKey) return false;
  return categoryUnavailable.has(String(productKey).trim().toLowerCase());
}

/**
 * Can a ticket for this product be created today, or would the nested chain 400?
 * @param {string} productKey a cf_custom_tags value (or any free text)
 */
export function isCategoryAvailable(productKey) {
  if (!productKey) return false;
  if (isProductUnfilable(productKey)) return false;
  return !!mapCategory(productKey);
}

// ⚠ These are matched against the RAW caller text, INDEPENDENTLY of RULES above — they are
// not a second opinion on mapProduct()'s answer. The stove rule in particular is broad
// enough to claim phrasings whose product is unfilable ("induction stove", "induction
// cooktop", "induction hob", "cooker hob" all match it), so a non-null answer here is NOT
// proof that a ticket can be filed. Only isProductUnfilable() settles that; ticket-fields.js
// asks it FIRST. Widening any rule below is safe only while that order holds.
//
// ⭐ 2026-07-20 — that order is now MORE load-bearing, not less. truTRTL does not sell gas
// stoves any more, but the 'Gas Stoves' node is deliberately kept alive for legacy owners
// (see TRUTRTL_CATEGORIES above), so the loose stove rule still resolves to a REAL, filable
// category. It is therefore still the case that "induction stove" / "induction cooktop" /
// "induction hob" / "cooker hob" get a confident non-null category here, and still only
// isProductUnfilable() — asked first, in ticket-fields.js — stops them being filed as one.
//
const CATEGORY_RULES = [
  // ⭐ M-12 — MUST STAY ABOVE THE MIXER RULE, for the same first-match-wins reason as its
  // twin in RULES. "chopper grinder" / "chopper cum grinder" / "chopper mixer" / "mini
  // chopper blender" all match /\b(mixer|grinder|juicer|blender)\b/, so with this line
  // below the mixer rule a chopper would file as Mixer Grinder / Trutrtl-Nutri-Insta-2Jar —
  // a real ticket against the wrong product. It used to be isProductUnfilable() that caught
  // that; now the chopper is filable, THIS ORDERING is the only thing standing in the way.
  [/\bchopper\b/i, 'Electric chopper'],
  [/\bair\s*fry/i, 'Air fryer'],
  // M-6: qualifier REQUIRED, bare "fan" demoted to the last-resort rule at the bottom —
  // kept character-for-character in step with the RULES fan pair above. The two lists must
  // agree about what a "fan" is, or one vocabulary starts claiming what the other refuses.
  [/\b(ceiling|pedestal|wall|table)\s*fan\b/i, 'Ceiling Fans'],
  [/\bkettle\b/i, 'Kettle'],
  [/\begg\b/i, 'Egg Boilers'],
  [/\b(sandwich|grill|toast|waffle)\b/i, 'Sandwich Maker'],
  [/\b(mixer|grinder|juicer|blender)\b/i, 'Mixer Grinder'],
  [/\b(gas\s*stove|stove|cooktop|hob)\b/i, 'Gas Stoves'],
  [/\bfan\b/i, 'Ceiling Fans'], // LAST RESORT — keep last.
];

// Representative default SKU per category (used when the caller can't give a model).
const DEFAULT_SKU = {
  'Ceiling Fans': 'Trutrtl-Smart-1200 MM',
  Kettle: 'Electric-1.5 Kettle',
  'Egg Boilers': '7Egg Plastic - White',
  'Air fryer': 'Manual(KZ-4505 M)',
  'Sandwich Maker': 'Grill-Sandwich Maker',
  'Mixer Grinder': 'Trutrtl-Nutri-Insta-2Jar',
  'Gas Stoves': 'Shakti 2B',
  // Black is the lead colour; the caller's stated colour reaches this via matchSku(model),
  // so "pink chopper" resolves to the Pink SKU rather than defaulting.
  'Electric chopper': 'Trutrtl-Smart-Chopper-Black',
};

/** Free-text product → a valid truTRTL product category (plural), or null. */
export function mapCategory(text) {
  if (!text) return null;
  const t = String(text).trim();
  const exact = Object.keys(TRUTRTL_CATEGORIES).find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  for (const [re, c] of CATEGORY_RULES) if (re.test(t)) return c;
  return null;
}

/**
 * ⭐ Pick a valid SKU for a category AND say whether the caller's model actually decided it.
 *
 * `matched` is the honest half. mapSku() answers "which SKU goes on the ticket", and it
 * always answers — an unrecognised model silently falls through to the category default,
 * which is correct for the payload (Freshdesk validates the chain, so we must send a real
 * SKU) and a lie in the description. Ravan's schema hands us exact tokens like "smart" and
 * "1.5"; the ones that miss ("smart" matches no Kettle SKU) used to arrive on the ticket as
 * 'Electric-1.5 Kettle' with NO "model not identified" warning, because the caller-facing
 * flag only asked whether a model string was PRESENT. Ops then read a defaulted model as a
 * confirmed one — the same "a placeholder that looks like data" class as the order date.
 *
 * @param {string} category a TRUTRTL_CATEGORIES key
 * @param {string} [model]  free-text model/variant as the caller/agent gave it
 * @returns {{sku: string|null, matched: boolean}} matched is true ONLY when `model` picked it
 */
export function matchSku(category, model) {
  const skus = TRUTRTL_CATEGORIES[category] || [];
  const m = model == null ? '' : String(model).trim().toLowerCase();
  if (m) {
    const hit = skus.find((s) => s.toLowerCase().includes(m) || m.includes(s.toLowerCase()));
    if (hit) return { sku: hit, matched: true };
  }
  return { sku: DEFAULT_SKU[category] || skus[0] || null, matched: false };
}

/**
 * Pick a valid SKU for a category; honour an optional caller-supplied model.
 * Unchanged for every existing caller — it is matchSku() with the honesty thrown away, so
 * requiredCustomFields() still always has a real SKU to send. Anything that REPORTS on the
 * value (fieldFallbacks) must use matchSku() instead.
 */
export function mapSku(category, model) {
  return matchSku(category, model).sku;
}
