// Builds the set of custom fields that digicart.freshdesk.com REQUIRES on ticket
// creation (verified live: cf_purchased_from, cf_brand121540, cf_order_date,
// cf_order_id, cf_city, cf_state, cf_pin_code, cf_given_to_service_partner,
// cf_group_custom). Missing values get clear placeholders so creation never 400s;
// ops reconciles real values from the WhatsApp invoice.
//
// ⚠ CORRECTED (M-3, §9 defect 6). This header used to claim cf_custom_tags (product)
// "is NOT required, so it's only set when we can map it". That was FALSE: the returned
// object had ELEVEN keys and cf_custom_tags was not one of them, so it was never set —
// not when we could map it, not ever. Every voice ticket landed with an EMPTY product
// dropdown, which is the field digiCART's saved views and product reports filter on, so
// voice complaints silently dropped out of the views ops actually works from. It IS
// optional — that part was true — so it is written CONDITIONALLY (`if (tag)`), never
// defaulted: mapProduct() returning null still means "leave it unset", exactly as
// lib/product-map.js promises.
//
// ⚠ SINGULAR vs PLURAL, the trap this file must never fall into: cf_custom_tags takes
// mapProduct() ('Ceiling Fan', 'Egg boiler', 'Gas Stove'); cf_product_category takes
// mapCategory() ('Ceiling Fans', 'Egg Boilers', 'Gas Stoves'). Two independent
// vocabularies — copying a string from one into the other 400s the create or corrupts
// the dropdown. Each field is filled from its OWN mapper below; never from the other's
// result, and never from a variable that has already been through the other mapper.
//
// ⚠ THIS MODULE NOW FAILS LOUDLY. Both silent fallbacks are gone, by design.
// It used to do `mapCategory(o.product) || 'Ceiling Fans'` (§9.1 #2) and
// `mapPlatform(o.platform) || 'Website'` (§9.1 #8), so a complaint nobody understood
// still became a confident, fully-populated, WRONG ticket:
//   • Induction / Cooker / Iron — in the cf_custom_tags dropdown (shared with MILTON,
//     which sells them) and in Tara's enum, with no node in the truTRTL brand tree —
//     filed as CEILING FANS with the fabricated model 'Trutrtl-Smart-1200 MM'. Ops
//     schedules technicians off those fields. ⭐ 2026-07-20: truTRTL confirmed it does
//     not sell any of the three, so refusing them is now settled policy, not a gap.
//   • Meesho / Jabong — legacy truTRTL channels with no cf_purchased_from value —
//     filed as 'Website', pushing a marketplace customer into truTRTL's own 7-day
//     return flow and asking them for the wrong invoice. ⭐ 2026-07-20: neither is on
//     the client's current buy list either, so this refusal is permanent too.
// Now an unfilable product or platform throws a TicketFieldError carrying a code the
// route can branch on, so Tara can say "I can't file that right now" — which is true —
// instead of misfiling it.
//
// Missing OPTIONAL detail still gets placeholders (NA / 0) so a create never 400s on a
// caller who simply didn't have their order id — see fieldFallbacks(), which reports
// exactly which values are placeholders so the description can say so.
//
// ⚠ THE ORDER DATE IS NO LONGER ONE OF THEM (M-7, §9 defect 16). cf_order_date used to
// be `isISODate(o.orderDate) ? o.orderDate : todayISO()`, and Tara asks "roughly when did
// you get it?" — which yields "about two months ago", never an ISO string — so the field
// read TODAY on effectively every voice ticket. Warranty runs from this date, so a
// two-year-old fan looked bought this morning: the single most misleading value the field
// can hold, and it looked like data. Now normalizeOrderDate() resolves what the caller
// actually said against the call time in Asia/Kolkata, and when nothing survives that we
// file the ORDER_DATE_NOT_CAPTURED sentinel — unmistakably not a purchase date — never
// today.
import { config } from './config.js';
import { mapPlatform, isUnmappedChannel } from './platform-map.js';
import {
  mapCategory, mapSku, matchSku, mapProduct, isCategoryAvailable, isProductUnfilable,
  isMappingPending,
} from './product-map.js';

/** Thrown when a ticket cannot be filed truthfully. `code` is for the route to branch on. */
export class TicketFieldError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'TicketFieldError';
    this.code = code;   // unknown_product | category_unavailable | unknown_platform | unmapped_channel
    this.field = field; // the cf_* key that could not be filled
  }
}

/** YYYY-MM-DD for "today" in the configured timezone (en-CA renders ISO date). */
export function todayISO(tz = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// (The old `isISODate()` helper is gone with M-7. Its only two callers treated "not ISO"
// as "use today", which is the defect; normalizeOrderDate() answers the real question —
// what did the caller actually say, and how sure are we — and validates the date itself.)

// ─────────────────────────────────────────────────────────────────────────────────────
// M-7 — natural-language purchase date → ISO, resolved against the CALL time in IST.
//
// The sentinel filed when the caller's date cannot be resolved. cf_order_date is a
// REQUIRED field on create, so omitting it risks a 400 that would cost the caller their
// ticket — and the middleware must never turn a real complaint into nothing. 1900-01-01
// is filed instead: no truTRTL product was bought in 1900, so no human and no report can
// mistake it for data, and fieldFallbacks() says so out loud in the description.
//
// [CONFIRM] Whether cf_order_date accepts null on this tenant is UNVERIFIED — it was
// never tested against digicart.freshdesk.com, only inferred from the field being marked
// required. Before go-live, POST one throwaway ticket with cf_order_date:null (and one
// omitting the key entirely) against the live desk. If either is accepted, prefer that:
// an empty field is more honest than any sentinel, and this constant plus the two call
// sites below are the only things that need to change. Until that is checked, the
// sentinel stands — what must NOT come back under any circumstance is today's date.
export const ORDER_DATE_NOT_CAPTURED = '1900-01-01';

// Purchase dates older than this are treated as unparsed rather than believed. It also
// makes the sentinel round-trip safely: feed ORDER_DATE_NOT_CAPTURED back in and you get
// { iso: null, precision: 'unknown' }, not a 1900 purchase.
const EARLIEST_PLAUSIBLE_YEAR = 1990;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// Callers say "a month ago" and "a couple of months back" far more often than "1 month".
const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, couple: 2, two: 2, three: 3, few: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// ⭐ HINGLISH. Tara's prompt locks the call to Hinglish, so the answer to "roughly when did
// you get it?" comes back in Hinglish at least as often as in English — "do mahine pehle",
// "pichle saal", "2 saal pehle". Every one of those used to fall through to the 1900-01-01
// sentinel, i.e. the parser was English-only on a call that is not. Romanisation is not
// standardised, so the common spellings are all listed rather than guessed at with a regex.
const HINGLISH_NUMBERS = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, chah: 6,
  saat: 7, aath: 8, nau: 9, das: 10, dus: 10, gyarah: 11, barah: 12,
};

// Hinglish unit → the same unit the English branch uses, so both share one arithmetic path.
const HINGLISH_UNITS = {
  din: 'day', dino: 'day', dinon: 'day',
  hafta: 'week', hafte: 'week', haftey: 'week', hafton: 'week', saptah: 'week',
  mahina: 'month', mahine: 'month', maheena: 'month', maheene: 'month',
  mahiney: 'month', mahino: 'month', mahinon: 'month',
  saal: 'year', sal: 'year', varsh: 'year', baras: 'year',
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
const isoOf = ({ y, m, d }) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const isRealDate = ({ y, m, d }) => {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
// All arithmetic runs on UTC-midnight instants built from IST calendar parts, so the
// server's own timezone can never shift the answer by a day.
const partsOf = (ms) => {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const msOf = ({ y, m, d }) => Date.UTC(y, m - 1, d);
const addDays = (p, n) => partsOf(msOf(p) + n * 86400000);
const addMonths = (p, n) => {
  const total = (p.y * 12) + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // "31 January" − 1 month → 31 Feb
  return { y, m, d: Math.min(p.d, lastDay) };
};

/** The call date as IST calendar parts. en-CA renders ISO, which parses without ambiguity. */
function istParts(now = new Date(), tz = config.timezone) {
  const when = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(when).split('-').map(Number);
  return { y, m, d };
}

const isAfter = (a, b) => msOf(a) > msOf(b);

/** Most recent day/month on or before the call date — "26 May" means the one that passed. */
function mostRecentPastDayMonth(today, m, d) {
  let y = today.y;
  if (m > today.m || (m === today.m && d > today.d)) y -= 1;
  // 29 February in a non-leap year: step back to the leap year the caller must have meant.
  for (let i = 0; i < 8; i += 1) {
    if (isRealDate({ y, m, d })) return { y, m, d };
    y -= 1;
  }
  return null;
}

/** Most recent occurrence of a month. "last January" in January means the previous one. */
function mostRecentPastMonth(today, m, explicitLast) {
  let y = today.y;
  if (m > today.m || (m === today.m && explicitLast)) y -= 1;
  return { y, m, d: 1 };
}

/**
 * ⭐ M-7. Free text → { iso, precision }, resolved against the CALL time in Asia/Kolkata.
 *
 * `precision` is the honest half of the answer and the description prints it:
 *   • 'exact'       — the caller named a specific day AND its year ('2026-05-26',
 *                     '26/05/2026', 'yesterday'). Still not proof of the INVOICE date.
 *   • 'approximate' — we resolved it by inference: a relative offset ('two months ago'),
 *                     a month with no day ('last January'), or a day whose YEAR we had to
 *                     infer ('26 May'). An inferred year is exactly how a two-year-old fan
 *                     becomes a warranty claim, so it is never reported as exact.
 *   • 'unknown'     — nothing resolvable. iso is null; the caller gets a ticket anyway,
 *                     with the sentinel and a description line saying it wasn't captured.
 *
 * @param {string|Date} text  whatever the caller/agent gave us
 * @param {Date} [now]        the call time (injectable so tests never depend on the clock)
 * @returns {{iso: string|null, precision: 'exact'|'approximate'|'unknown'}}
 */
export function normalizeOrderDate(text, now = new Date()) {
  const unknown = { iso: null, precision: 'unknown' };
  if (text == null) return unknown;

  const today = istParts(now);

  if (text instanceof Date) {
    if (Number.isNaN(text.getTime())) return unknown;
    const p = istParts(text);
    return (p.y < EARLIEST_PLAUSIBLE_YEAR || isAfter(p, today)) ? unknown : { iso: isoOf(p), precision: 'exact' };
  }

  let t = String(text).trim().toLowerCase();
  if (!t) return unknown;
  // Strip the hedging Tara's own question invites ("roughly when did you get it?").
  for (let i = 0; i < 4; i += 1) {
    const stripped = t
      .replace(/^(i\s+)?(bought|purchased|got)\s+(it\s+)?(on|in|at|around)?\s*/, '')
      .replace(/^(it\s+was|maybe|about|around|approx(?:imately)?|roughly|somewhere|sometime|some\s+time|like|in|on|the)\s+/, '')
      .replace(/[.,!?]+$/, '')
      .trim();
    if (stripped === t) break;
    t = stripped;
  }
  if (!t) return unknown;

  const finish = (p, precision) => {
    if (!p || !isRealDate(p)) return unknown;
    // A purchase cannot be in the future, and a 1970s date is a parse artefact, not a
    // sale. Either way we'd rather say "not captured" than file a date we don't believe.
    if (p.y < EARLIEST_PLAUSIBLE_YEAR || isAfter(p, today)) return unknown;
    return { iso: isoOf(p), precision };
  };

  // 1. ISO, the one form that is already unambiguous.
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return finish({ y: +iso[1], m: +iso[2], d: +iso[3] }, 'exact');

  // 2. Numeric date. DAY-FIRST: this is an Indian desk and the subject line the client's
  //    own automation parses is dd.mm.yyyy, so 05/06/2026 is 5 June, not 6 May.
  const dmy = t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (dmy) {
    const y = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return finish({ y, m: +dmy[2], d: +dmy[1] }, 'exact');
  }

  // 3. Named days.
  if (/^(today|aaj)$/.test(t)) return finish(today, 'exact');
  if (/^(yesterday|kal)$/.test(t)) return finish(addDays(today, -1), 'exact');
  if (/^day\s+before\s+yesterday$/.test(t)) return finish(addDays(today, -2), 'exact');
  if (/^last\s+week$/.test(t)) return finish(addDays(today, -7), 'approximate');
  if (/^last\s+month$/.test(t)) return finish(addMonths(today, -1), 'approximate');
  if (/^last\s+year$/.test(t)) return finish(addMonths(today, -12), 'approximate');

  // 4. Relative offsets — the phrasing Tara's question actually produces.
  //    "ago"/"back"/"before"/"old" is optional: in a field that can only hold a purchase
  //    date, a bare "two months" has no other possible reading.
  // One arithmetic path for both languages: whatever the caller said, it ends up here.
  const backBy = (unit, n) => {
    if (unit === 'day') return addDays(today, -n);
    if (unit === 'week') return addDays(today, -7 * n);
    if (unit === 'month') return addMonths(today, -n);
    return addMonths(today, -12 * n);
  };

  const rel = t.match(/^(?:a\s+)?(\d{1,3}|[a-z]+)\s*(?:of\s+)?(day|week|month|year)s?(?:\s+(?:ago|back|before|old|earlier|prior))?$/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : WORD_NUMBERS[rel[1]];
    if (n) return finish(backBy(rel[2], n), 'approximate');
  }

  // 4b. ⭐ THE SAME THING IN HINGLISH — "do mahine pehle", "2 saal pehle", "das din pehle".
  //     The call is Hinglish-locked; an English-only parser here filed the 1900 sentinel on
  //     answers that were perfectly clear. The number may be Hinglish (do / teen / das), a
  //     digit, or an English word ("two mahine" — code-switching mid-phrase is normal).
  //     "pehle"/"pahle" is optional for the same reason "ago" is: in a field that can hold
  //     only a purchase date, "do mahine" has no other reading.
  const hin = t.match(/^(\d{1,3}|[a-z]+)\s+([a-z]+)(?:\s+(?:pehle|pahle|pehley|pahley|pehale|purane|purana|purani|back|ago|old|hue|hua|ho\s+gaye|ho\s+gaya|ho\s+chuke|hogaye))?$/);
  if (hin && HINGLISH_UNITS[hin[2]]) {
    const n = /^\d+$/.test(hin[1]) ? Number(hin[1]) : (HINGLISH_NUMBERS[hin[1]] ?? WORD_NUMBERS[hin[1]]);
    if (n) return finish(backBy(HINGLISH_UNITS[hin[2]], n), 'approximate');
  }
  // "pichle saal" / "pichle mahine" / "pichle hafte" — the Hinglish twin of "last year".
  const hinLast = t.match(/^(?:pichhle|pichle|pichley|pichla|pichhla|pichale)\s+([a-z]+)$/);
  if (hinLast && HINGLISH_UNITS[hinLast[1]]) {
    return finish(backBy(HINGLISH_UNITS[hinLast[1]], 1), 'approximate');
  }

  // 5. Month-name forms. A named day with a stated year is the only 'exact' one here —
  //    when the year has to be inferred, warranty could be a whole year out, so it is
  //    reported as approximate no matter how confident the day looks.
  const dMonY = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\.?,?\s*(\d{4})?$/);
  if (dMonY && MONTHS[dMonY[2]]) {
    const m = MONTHS[dMonY[2]];
    const d = Number(dMonY[1]);
    if (dMonY[3]) return finish({ y: Number(dMonY[3]), m, d }, 'exact');
    return finish(mostRecentPastDayMonth(today, m, d), 'approximate');
  }
  const monDY = t.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/);
  if (monDY && MONTHS[monDY[1]]) {
    const m = MONTHS[monDY[1]];
    const d = Number(monDY[2]);
    if (monDY[3]) return finish({ y: Number(monDY[3]), m, d }, 'exact');
    return finish(mostRecentPastDayMonth(today, m, d), 'approximate');
  }
  // ⭐ "<month> last year" / "<month> this year" — the trailing form of "last January", and
  // PRECISELY what Phase 2.4's "which month and year did you buy it?" elicits in English.
  // The leading form was handled and this one was not, so the answer the prompt asks for
  // filed the 1900 sentinel. "pichle saal" is accepted as the year word for the same reason
  // the block above exists. Day unknown → the 1st, and always approximate.
  const monYear = t.match(/^([a-z]+)\.?,?\s+(last|this|pichle|pichhle|is)\s+(year|saal|sal|varsh)$/);
  if (monYear && MONTHS[monYear[1]]) {
    const thisYear = monYear[2] === 'this' || monYear[2] === 'is';
    return finish({ y: thisYear ? today.y : today.y - 1, m: MONTHS[monYear[1]], d: 1 }, 'approximate');
  }
  // Month alone ("last January", "March 2025") — day unknown, so always approximate and
  // always the 1st, which is the earliest day it could be (never flatters the warranty).
  const monOnly = t.match(/^(last\s+|this\s+)?([a-z]+)\.?,?\s*(\d{4})?$/);
  if (monOnly && MONTHS[monOnly[2]]) {
    const m = MONTHS[monOnly[2]];
    if (monOnly[3]) return finish({ y: Number(monOnly[3]), m, d: 1 }, 'approximate');
    return finish(mostRecentPastMonth(today, m, /^last\s+$/.test(monOnly[1] || '')), 'approximate');
  }

  // 6. A bare year.
  const yr = t.match(/^(\d{4})$/);
  if (yr) {
    const y = Number(yr[1]);
    if (y >= EARLIEST_PLAUSIBLE_YEAR && y <= today.y) return finish({ y, m: 1, d: 1 }, 'approximate');
  }

  return unknown;
}

/**
 * The honest refusal for a REAL truTRTL product with no node in the brand tree.
 * `wouldHaveBeenFiledAs` is the category the loose CATEGORY_RULES would have handed us —
 * named out loud in the message, because that fabricated value is the whole defect.
 */
function categoryUnavailableResult(productKey, wouldHaveBeenFiledAs) {
  return {
    ok: false,
    code: 'category_unavailable',
    field: config.cf.productCategory,
    message: `"${productKey}" is a real truTRTL product but has no category under `
      + `${config.cf.brandValue} on ${config.cf.brand}, so Freshdesk would reject this `
      + 'ticket (invalid Brand→Category→SKU chain). An admin must add the category + '
      + `its SKUs first. Refusing to file it as ${wouldHaveBeenFiledAs || 'a Ceiling Fan'} `
      + 'with a fabricated model.',
  };
}

/**
 * Non-throwing pre-check. Lets a route reject politely (and let Tara say something
 * useful) without a try/catch. Returns { ok:true } or { ok:false, code, field, message }.
 */
export function validateComplaint(o = {}) {
  const productKey = mapProduct(o.product);
  const category = mapCategory(o.product);

  // ⭐ PRECEDENCE, NOT FALLBACK. This check used to sit INSIDE the `if (!category)` below,
  // so it was only reached when mapCategory() gave up — but the two vocabularies are
  // matched INDEPENDENTLY of each other, and the category one is looser. CATEGORY_RULES'
  // /\b(gas\s*stove|stove|cooktop|hob)\b/ swallows "induction stove", "induction cooktop",
  // "induction hob" (and "cooker hob"), so mapCategory() returned a confident WRONG
  // category, the unfilable-product check never ran, and a broken induction was filed as a
  // GAS STOVE with the fabricated SKU 'Shakti 2B' — which ops then routes and schedules a
  // technician from — while Tara read back its complaint number. Only a BARE "induction"
  // took the honest path, and "induction stove" is the commoner Indian-English phrasing,
  // so the bypass was the normal case rather than an edge one. Recognising the product as
  // unfilable now beats ANY category match: what the caller owns decides whether we can
  // file, and a category regex is not evidence about that.
  if (isProductUnfilable(productKey)) return categoryUnavailableResult(productKey, category);

  // ⭐ RECOVERABLE, and it must be decided HERE — above the `!category` branch, for the same
  // precedence reason as the check above it. Toaster and Water Boiler are recognised but
  // have no dropdown value and no node, so a payload can never be built for them; what is
  // still open is whether one SHOULD exist ([CONFIRM] with ops). Until that is answered the
  // useful thing is for Tara to ASK AGAIN — "water boiler" is very often an electric kettle,
  // and a caller who then says "sandwich toaster" files a real Sandwich Maker ticket. So
  // this is `unknown_product` (register-complaint.js: recoverable → Tara re-asks), NOT
  // `category_unavailable` (terminal → callback, no ticket).
  //
  // Above the `!category` branch because the two vocabularies are matched INDEPENDENTLY and
  // the category one is looser: "toaster mixer" is a Toaster to mapProduct() and a Mixer
  // Grinder to mapCategory(), and "water boiler fan noise" picks up the last-resort Ceiling
  // Fans rule. Deciding lower down would file those under a borrowed category with the
  // recognise-only name written to cf_custom_tags — an illegal dropdown value that 400s.
  if (isMappingPending(productKey)) {
    return {
      ok: false,
      code: 'unknown_product',
      field: config.cf.product,
      message: `"${productKey}" is a real truTRTL product, but it has no ${config.cf.product} `
        + `value and no node under ${config.cf.brandValue} yet ([CONFIRM] pending with ops), `
        + 'so there is nothing correct to file it as. Asking the caller which product it is '
        + 'can still resolve it — a "water boiler" is often an electric kettle, and a '
        + '"sandwich toaster" is a Sandwich Maker. Refusing to guess '
        + `${category || 'a category'} in the meantime.`,
    };
  }

  if (!category) {
    // Reached only when the product is recognised (or not) and NOT on the unfilable list.
    // A recognised product with no category means a CATEGORY_RULES entry has drifted out of
    // sync with the tree — same honest refusal, still never a guess. Text we never
    // recognised is a different verdict: one is an admin gap someone can close, the other
    // means "ask the caller again".
    if (productKey && !isCategoryAvailable(productKey)) {
      return categoryUnavailableResult(productKey, category);
    }
    return {
      ok: false,
      code: 'unknown_product',
      field: config.cf.productCategory,
      message: `Product "${o.product ?? ''}" does not map to any truTRTL category. `
        + 'Refusing to file it under a guessed category.',
    };
  }
  const platform = mapPlatform(o.platform);
  if (!platform) {
    const channel = isUnmappedChannel(o.platform);
    return {
      ok: false,
      code: channel ? 'unmapped_channel' : 'unknown_platform',
      field: config.cf.platform,
      message: channel
        ? `"${o.platform}" is a real truTRTL sales channel (it is in the KB's own list) `
          + `but has NO value on ${config.cf.platform}. [CONFIRM] with ops whether the `
          + 'dropdown should gain it; there is nothing correct to file today.'
        : `Platform "${o.platform ?? ''}" does not map to any ${config.cf.platform} choice `
          + '(there is no "Other" option on this dropdown). Refusing to default it to '
          + 'Website — that would silently change which return policy applies and which '
          + 'invoice we ask the customer for.',
    };
  }
  return { ok: true };
}

/** Caller text quoted back to ops — one line, bounded, so a rambling answer can't wreck the description. */
const quoteSaid = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * Report which values are placeholders rather than real data, so the ticket description
 * can say so out loud. Returned separately (not merged into the fields) to keep the
 * payload shape clean — the route appends `.lines` to its description.
 *
 * ⭐ M-7: the order date is no longer a two-state "real or today". It has THREE states and
 * ops must be told which one they are looking at, because the field looks identical in
 * Freshdesk either way: an exact date (silent — it is real data), an APPROXIMATE date we
 * derived from what the caller said (named out loud, with the words they used and the date
 * we resolved), or NOT CAPTURED (the sentinel, never today).
 *
 * @param {object} o
 * @param {Date} [now] the call time, passed straight through to normalizeOrderDate()
 * ⭐ The SKU has two placeholder states too, and they read differently to ops: no model was
 * given at all, or one WAS given and matched nothing in the tree (so cf_product holds a
 * different model from the one the caller said). `skuModelUnmatched` distinguishes them.
 *
 * @returns {{orderDateDefaulted:boolean, orderDatePrecision:'exact'|'approximate'|'unknown',
 *            orderDateISO:string|null, orderDateFiled:string, skuDefaulted:boolean,
 *            skuModelUnmatched:boolean, orderIdMissing:boolean, locationMissing:boolean,
 *            productTagMissing:boolean, lines:string[]}}
 */
export function fieldFallbacks(o = {}, now = new Date()) {
  const category = mapCategory(o.product);
  // ⭐ ASK THE MAPPER WHETHER IT MATCHED — do not infer it from "a model string arrived".
  // This was `!!sku && !o.model`, so { product:'kettle', model:'smart' } filed
  // 'Electric-1.5 Kettle' with skuDefaulted:false and NO warning line: "smart" matches no
  // Kettle SKU, yet it is one of the exact tokens Ravan's schema tells Tara to send. Ops saw
  // a model that looked confirmed and was defaulted — the same class of defect as the order
  // date reading "today". matchSku() now reports the truth and both states are named below.
  const { sku, matched: skuMatched } = category
    ? matchSku(category, o.model)
    : { sku: null, matched: false };
  const modelSaid = o.model == null ? '' : String(o.model).trim();
  const skuDefaulted = !!sku && !skuMatched;
  // The worse of the two: the caller DID give a model and we quietly filed a different one.
  const skuModelUnmatched = skuDefaulted && !!modelSaid;
  const { iso: orderDateISO, precision: orderDatePrecision } = normalizeOrderDate(o.orderDate, now);
  const orderDateFiled = orderDateISO || ORDER_DATE_NOT_CAPTURED;
  // Kept as the same boolean the route and its tests already read — "this field is not a
  // date the caller confirmed" — but it is now true for approximate dates as well, which
  // is the honest reading: an inferred year is not a captured one.
  const orderDateDefaulted = orderDatePrecision !== 'exact';
  const orderIdMissing = !(o.orderId && String(o.orderId).trim());
  const locationMissing = !(o.city && String(o.city).trim()) || !Number.isFinite(o.pin);
  // M-3: the dropdown is optional, so a product we can't map leaves it EMPTY rather than
  // guessed — and an empty cf_custom_tags is exactly what drops a ticket out of digiCART's
  // product-filtered views, so ops has to hear about it.
  const productTagMissing = !mapProduct(o.product);

  const lines = [];
  if (orderDatePrecision === 'unknown') {
    lines.push(
      '⚠ Order date NOT captured on the call — cf_order_date holds the sentinel '
      + `${ORDER_DATE_NOT_CAPTURED}, which means "not captured". It is NOT a purchase date and `
      + '(deliberately) NOT today. Warranty runs 1 year from the INVOICE date, so do not assess '
      + 'warranty off this field; reconcile it from the invoice on WhatsApp.',
    );
  } else if (orderDatePrecision === 'approximate') {
    lines.push(
      `⚠ Order date is APPROXIMATE — the caller said "${quoteSaid(o.orderDate)}", resolved `
      + `against the call date to ${orderDateFiled}, which is what cf_order_date holds. Treat it `
      + 'as the caller\'s estimate, not a date. Warranty runs 1 year from the INVOICE date — '
      + 'confirm from the invoice on WhatsApp before assessing warranty.',
    );
  }
  if (productTagMissing) {
    lines.push(
      `⚠ Product dropdown not set — "${quoteSaid(o.product ?? '')}" does not match any `
      + `${config.cf.product} value, so it was left EMPTY rather than guessed. This ticket will `
      + 'not appear in product-filtered views until someone sets it by hand.',
    );
  }
  if (skuModelUnmatched) {
    // Names the token that failed, because that token is the evidence: it tells ops (and
    // whoever tunes Tara's enum) that the agent sent something the tree has no SKU for.
    lines.push(
      `⚠ Model "${quoteSaid(modelSaid)}" does NOT match any ${category} model on this desk — `
      + `cf_product was defaulted to ${sku}, so the model on this ticket is NOT the one the `
      + 'caller gave. Confirm from the invoice.',
    );
  } else if (skuDefaulted) {
    lines.push(
      `⚠ Model not identified on the call — cf_product defaulted to ${sku}. Confirm from the invoice.`,
    );
  }
  if (orderIdMissing) lines.push('⚠ Order ID not provided — cf_order_id is "NA". The invoice substitutes.');
  // Same NO-silent-fallbacks rule as the fields above: when pincode is absent/garbage,
  // requiredCustomFields() files cf_pin_code:0 and cf_city/cf_state:'NA' — placeholders, not
  // data — so the description MUST say so out loud. cf_pin_code:0 is not a real PIN.
  if (locationMissing) lines.push('⚠ Location incomplete — city/state/pin may be placeholders (cf_pin_code defaulted to 0).');
  return {
    orderDateDefaulted,
    orderDatePrecision,
    orderDateISO,
    orderDateFiled,
    skuDefaulted,
    skuModelUnmatched,
    orderIdMissing,
    locationMissing,
    productTagMissing,
    lines,
  };
}

/**
 * @param {object} o
 * @param {string} [o.platform]  free-text platform (mapped to a dropdown choice)
 * @param {string} [o.product]   free-text product (mapped to the nested category + SKU)
 * @param {string} [o.model]     free-text model/variant. OPTIONAL and rarely known; when
 *                               absent, fieldFallbacks() flags the SKU as defaulted.
 * @param {string} [o.orderId]
 * @param {string} [o.orderDate] anything the caller said — ISO, "26 May", "two months ago".
 *                               normalizeOrderDate() resolves it; it is NEVER defaulted to today.
 * @param {string} [o.city]
 * @param {string} [o.state]
 * @param {number} [o.pin]
 * @param {Date} [now] the call time — injectable so a relative date resolves against the
 *                     call, not against whenever a retry happened to run.
 * @throws {TicketFieldError} when the product or platform cannot be filed truthfully
 */
export function requiredCustomFields(o = {}, now = new Date()) {
  const cf = config.cf;
  const check = validateComplaint(o);
  if (!check.ok) throw new TicketFieldError(check.code, check.message, check.field);

  // Brand nested chain — all three levels must be a valid, consistent path or the
  // create 400s. validateComplaint() has already proven this triple exists, which is
  // why there is no `|| 'Ceiling Fans'` here any more.
  const category = mapCategory(o.product);
  const sku = mapSku(category, o.model);
  const out = {
    [cf.brand]: cf.brandValue,                                  // truTRTL  (level 1)
    [cf.productCategory]: category,                             // level 2 (required) — PLURAL
    [cf.productSku]: sku,                                       // level 3
    [cf.platform]: mapPlatform(o.platform),                     // required dropdown
    [cf.servicePartner]: 'No',                                  // required dropdown
    [cf.groupCustom]: config.groupCustomValue,                  // required dropdown (WITH DIGICART)
    // ⭐ M-7 (§9 defect 16). This line WAS `isISODate(o.orderDate) ? o.orderDate : todayISO()`.
    // Tara asks "roughly when did you get it?", so what arrives is "about two months ago" —
    // never ISO — and the field therefore read TODAY on essentially every voice ticket, on a
    // desk where warranty runs from this date. normalizeOrderDate() now resolves the caller's
    // own words against the call time in IST; when nothing resolves we file the sentinel,
    // which no one can mistake for a purchase date. fieldFallbacks() reports the precision so
    // the description says which of the three it is.
    // [CONFIRM] cf_order_date is REQUIRED on create, so null/omitted may 400 — unverified
    // against the live desk. See ORDER_DATE_NOT_CAPTURED above for the test to run before
    // go-live; if null is accepted, prefer it to the sentinel.
    [cf.purchaseDate]: normalizeOrderDate(o.orderDate, now).iso || ORDER_DATE_NOT_CAPTURED,
    [cf.orderId]: (o.orderId && String(o.orderId).trim()) || 'NA',
    [cf.city]: (o.city && String(o.city).trim()) || 'NA',
    [cf.state]: (o.state && String(o.state).trim()) || 'NA',
    [cf.pin]: Number.isFinite(o.pin) ? o.pin : 0,
  };

  // ⭐ M-3 (§9 defect 6). cf_custom_tags — the FLAT product dropdown, and the field
  // digiCART's saved views filter on. It was missing from this object entirely, so every
  // voice ticket landed with it empty and fell out of those views; the header comment
  // claiming it "is only set when we can map it" described code that never existed.
  //
  // ⚠ mapProduct(), NOT mapCategory(), and NOT `category` from four lines up. This dropdown
  // is SINGULAR ('Ceiling Fan', 'Egg boiler', 'Gas Stove'); cf_product_category is PLURAL
  // ('Ceiling Fans', 'Egg Boilers', 'Gas Stoves'). Two separate vocabularies on one desk —
  // writing the plural here corrupts the dropdown, and it is a one-character-looking edit.
  //
  // Written CONDITIONALLY because the field is genuinely optional and the two vocabularies
  // are matched INDEPENDENTLY: a caller (or another route) who says the category name
  // "Ceiling Fans" maps to a valid category but to NO product choice — /\bfan\b/ does not
  // match "Fans" — so mapProduct() returns null. Null means leave it unset. We never fill
  // it from the category, and never with a guess; fieldFallbacks() flags the empty field
  // instead so ops knows the ticket needs the dropdown set by hand.
  const tag = mapProduct(o.product);
  if (tag) out[cf.product] = tag;
  return out;
}
