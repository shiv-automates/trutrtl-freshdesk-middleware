// POST /freshdesk/register-complaint   (ENABLED — creates a real Freshdesk ticket)
// Mirrors digiCART's existing intake shape so voice tickets flow into the same views.
//
// Flow: auth → unwrapParams → validate → phone → gate → dedup → build → create → note →
//       (WhatsApp) → optional auto-close → 200 { complaint_number }
//
// ⭐ M-2 PHONE VALIDATION (defect 2). routes/complaint-status.js has always called
//    isValidIndianMobile(); this route never did — its only check was "non-empty". So a
//    misheard number ("nine eight seven..." → 8 digits, or an ASR hallucination) went
//    straight into toStorage(), which files the LAST TEN DIGITS of whatever it was handed
//    without ever asking whether they are a phone number. The ticket then carries a number
//    nobody can call back, and the document-request WhatsApp — the only way the invoice and
//    the issue video ever arrive — is sent to a stranger. Now the number is validated
//    BEFORE any write, and a bad one is a recoverable `invalid_phone`: Tara re-asks and
//    calls again, which costs one question instead of one lost complaint.
// ⭐ M-2 CALLER ID. `caller_id` (telephony ANI) is optional. When it disagrees with the
//    number the caller SAID, we still file — people legitimately call from a landline, a
//    spouse's phone or an office line — but ops gets both numbers and a private note to
//    verify, because that disagreement is also what a misheard number looks like.
// ⭐ M-7 ORDER DATE (defect 16). The caller's free text ("26 May", "two months ago") is
//    resolved to an ISO date against the call time in Asia/Kolkata by normalizeOrderDate(),
//    instead of being passed through raw — a non-ISO string used to be silently discarded
//    by requiredCustomFields() and replaced with TODAY, which makes a two-year-old fan look
//    bought this morning on the one field warranty is assessed from.
// ⭐ M-7 The fieldFallbacks() placeholder warnings now open the description instead of
//    trailing the issue text, where nobody scrolled to read them.
//
// ⭐ HONEST FAILURE (§9.1 🔴 #2, 🟠 #8). This route used to file whatever it was handed.
//    A caller reporting an Induction, a Cooker or an Iron — three products that ARE in
//    Tara's enum and in the cf_custom_tags dropdown, but have NO node in the 7-category
//    brand tree — got a ticket filed as a CEILING FAN with the fabricated model
//    'Trutrtl-Smart-1200 MM', and Tara read back its number as if it were their complaint.
//    A Meesho or Jabong purchase was silently filed as 'Website', moving the customer into
//    truTRTL's own 7-day return flow and asking them for the wrong invoice.
//    Now: if we cannot file the complaint CORRECTLY we say so (200 + a stable `reason` +
//    a line Tara can speak) and we create NOTHING. A wrong ticket is worse than no ticket,
//    because it looks handled.
// ⭐ The dedup key includes the issue text, and the slot is reserved BEFORE the create,
//    not after it (§9.1 🟠 #5 + §9.14 race).
// ⭐ No per-phrase issue tag (§9.14 tag explosion).
import { Router } from 'express';
import { config, brandTag, FRESHDESK } from '../lib/config.js';
import { logger, maskPhone } from '../lib/logger.js';
import { requireBearer } from '../lib/auth.js';
import * as fd from '../lib/freshdesk.js';
import { unwrapParams } from '../lib/ravan.js';
import { mapCategory } from '../lib/product-map.js';
import { mapPlatform } from '../lib/platform-map.js';
import {
  requiredCustomFields, validateComplaint, fieldFallbacks, normalizeOrderDate, TicketFieldError,
} from '../lib/ticket-fields.js';
import { toStorage, tenDigit, isValidIndianMobile } from '../lib/phone.js';
import { registerDedup } from '../lib/stores.js';
import { normalizeKey } from '../lib/idempotency.js';
import * as whapi from '../lib/whapi.js';
import { buildDocRequestMessage } from '../lib/whatsapp-message.js';

export const registerComplaintRouter = Router();

const REQUIRED = ['name', 'phone_number', 'product', 'platform', 'issue_description'];

// Voice-shaped failures. `spoken_hint` is written to be SAFE TO SAY VERBATIM on a live,
// recorded call — no field names, no system jargon, no blame on the caller, and no
// invented commitments (no SLA, no working hours, no timeframe: none of those are
// confirmed for truTRTL). The brand is spoken "True Turtle" and is NEVER spelled out.
const SPOKEN = {
  missing_required:
    "I just need a couple more details before I can file this for you.",
  // Never "that number is wrong" and never "I didn't hear you properly": on a recorded line
  // the caller must not be blamed for what the ASR did, and Tara must not claim the number
  // is invalid when what actually happened is that she heard it badly. Asking for it
  // digit by digit is the one instruction that fixes both causes.
  invalid_phone:
    "Let me just take that number again — could you say it digit by digit?",
  unmapped_product:
    "I want to make sure this goes against the right product — which True Turtle product is it exactly?",
  unmapped_platform:
    "And where did you buy it from — Amazon, Flipkart, our website, or somewhere else?",
  unmapped_channel:
    "For an order from that shopping site I'm not able to file it on this line myself. Let me take your details and have our team call you back on this number.",
  category_unavailable:
    "I'm not able to file this one on the system myself. Let me take your details and have our team call you back on this number.",
  freshdesk_error:
    "I'm having trouble filing this on the system right now. Let me take your details and have our team call you back on this number.",
};

const fail = (reason, extra = {}) => ({
  error: true,
  reason,
  spoken_hint: SPOKEN[reason],
  ...extra,
});

// lib/ticket-fields.js owns WHY a complaint can't be filed; this route owns what Tara
// SAYS about it. Their internal code → our wire contract (Ravan's function config and
// Tara's prompt branch on these strings — keep them stable).
const REASON_BY_CODE = {
  unknown_product: 'unmapped_product',
  category_unavailable: 'category_unavailable',
  unknown_platform: 'unmapped_platform',
  unmapped_channel: 'unmapped_channel',
};

// Recoverable in-call (Tara re-asks and calls again) vs terminal (the complaint dies here
// unless ops picks it up from the log). `invalid_phone` is deliberately RECOVERABLE — a
// misheard number is the one failure a single re-ask reliably fixes, and taking a callback
// on a number we already know is unreachable would be theatre.
const TERMINAL = new Set(['category_unavailable', 'unmapped_channel']);

/**
 * ⭐ M-2. The number the caller SAID vs the number the call came FROM (telephony ANI).
 * Returns null when there is nothing to compare — no caller_id, or one we can't read a
 * subscriber number out of ("anonymous", "private", a short code). We only flag a real
 * disagreement, because a false "verify this" on every second ticket teaches ops to ignore
 * the note, and then it stops working on the tickets where the number really was misheard.
 *
 * NOT a refusal: the caller may be calling from a landline, an office line or a relative's
 * phone, and the number they want to be reached on is the one they stated. Ops decides.
 */
function callerIdMismatch(p) {
  const stated = tenDigit(p.phone_number);
  const calledFrom = tenDigit(p.caller_id);
  if (!stated || !calledFrom || stated === calledFrom) return null;
  return { stated: toStorage(p.phone_number), calledFrom: toStorage(p.caller_id) };
}

// The exact phrase ops was promised on the ticket. Both numbers travel WITH it: a note that
// says "verify" without saying verify WHAT is a note nobody can action.
const CALLER_ID_NOTE = 'Caller stated a different number from the one they called from — verify';

function istParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [dd, mm, yyyy] = f.format(date).split('/');
  return { dd, mm, yyyy };
}

/** YYYY-MM-DD → DD-MM-YYYY for the subject; pass anything else through. */
function toDMY(d) {
  if (!d) return 'NA';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d);
}

/** Normalise the issue text for the dedup key: case/punctuation/whitespace-insensitive. */
function issueKey(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

/**
 * ⭐ The customer's information must not be lost.
 *
 * When we refuse to create a ticket, this WARN is the ONLY record that the complaint ever
 * happened — it has to carry everything ops needs to file it by hand AND to call the
 * customer back. A dropped complaint that nobody can trace is worse than the mis-filed
 * ticket we refused to write.
 *
 * ⚠ `callback_number` and `customer_name` deliberately carry raw values. lib/logger.js
 * redacts `phone`/`phone_number`/`mobile`/`name` by default, and a masked number cannot be
 * called back — so this is a conscious, narrow exception for the one code path where the
 * log IS the record. Flagged for owner review: if the privacy policy wins, this needs a
 * real sink (an ops queue or an "Unfiled" ticket), not a quieter log.
 */
function logUnfiled(reason, p, category) {
  logger.warn({
    reason,
    callback_number: String(p.phone_number || ''),
    // ⭐ M-2. When we refused to file, the ANI is a SECOND way to reach this customer — and
    // on the paths where the stated number was misheard it is the only working one. Same
    // deliberate raw-value exception as callback_number above, for the same reason: this
    // log entry IS the record, and a masked number cannot be called back.
    called_from_number: String(p.caller_id || ''),
    customer_name: String(p.name || ''),
    product_said: String(p.product || ''),
    category_mapped: category || null,
    platform_said: String(p.platform || ''),
    issue: String(p.issue_description || '').slice(0, 500),
    order_id: p.order_id || null,
    // ⭐ 2026-07-20 — carries MORE weight than it looks. On `unmapped_channel` (a legacy
    // Meesho/Jabong buyer, the only kind left now that neither is on truTRTL's buy list)
    // there is NO ticket, so this log line is the only place the warranty clock exists.
    // A 2024–25 buyer with a ceiling fan is in cover until 2027, and ops cannot assess that
    // by hand without a purchase month/year. If it is null here, Tara did not ask — that is
    // a prompt/KB fix (§12.C capture list), not a code one.
    order_date: p.purchase_date || null,
    city: p.city || null,
    state: p.state || null,
    pincode: p.pincode || null,
  }, 'UNFILED COMPLAINT — refused to create a wrong ticket. File this by hand and call the customer back.');
}

/**
 * The single input object for lib/ticket-fields.js. validateComplaint(),
 * requiredCustomFields() and fieldFallbacks() MUST see identical input, or the
 * description's "⚠ this is a placeholder" lines would describe fields the ticket doesn't
 * actually have — and the gate would clear a payload the create then rejects.
 */
function fieldInput(p, orderId, pin) {
  return {
    platform: p.platform,
    product: p.product,
    // `model` fixes the dead-param defect (§9.14) from the caller side: several categories
    // have multiple SKUs (two kettles, three air fryers), so a caller-stated variant is
    // the only thing that can pick the right level-3 value instead of the default. Tara
    // has no model field yet; this is wired for the day she does, and until then
    // fieldFallbacks() says out loud that the SKU was defaulted.
    model: p.model,
    orderId,
    // ⭐ M-7. The caller's RAW words, deliberately un-normalised — ticket-fields.js resolves
    // them itself, on both sides, against the `now` threaded in below.
    //
    // ⚠ This line used to pre-resolve to `normalizeOrderDate(p.purchase_date).iso`, which
    // silently LAUNDERED THE PRECISION and cost us the approximate warning on every voice
    // ticket that had one. fieldFallbacks() re-normalises whatever it is handed to decide
    // which of M-7's three states the date is in; hand it an ISO string and it can only
    // conclude 'exact'. So "two months ago" resolved to 2026-05-18, then read back as a
    // date the caller had confirmed — and the "⚠ Order date is APPROXIMATE … confirm from
    // the invoice before assessing warranty" line, the one M-7 moved to the TOP of the
    // description precisely because warranty gets decided off this field, never rendered.
    // Only the 'unknown' state survived the round trip (null re-reads as null), which is
    // why the sentinel warning still appeared and this stayed invisible. quoteSaid() would
    // also have echoed our own ISO back at ops instead of the words the caller used.
    //
    // Both consumers are documented to take "anything the caller said — ISO, '26 May',
    // 'two months ago'"; normalising ahead of them was the disagreement it meant to prevent.
    orderDate: p.purchase_date,
    city: p.city,
    state: p.state,
    pin,
  };
}

function buildPayload(p, { category }) {
  // ONE clock for the whole ticket. The subject's complaint date, the resolved order date,
  // the cf_* fields and the fallback warnings each used to call `new Date()` for themselves;
  // a relative date ("two months ago") resolves against that clock, so a create that straddled
  // midnight IST could put one day in the subject and another in cf_order_date on the same
  // ticket. Injectable for the same reason ticket-fields.js takes it: tests must not be timed.
  const now = new Date();
  const { dd, mm, yyyy } = istParts(now);
  const orderId = (p.order_id ?? '').toString().trim();
  const said = String(p.purchase_date ?? '').trim();
  const orderDate = normalizeOrderDate(p.purchase_date, now); // { iso, precision }

  // ⚠ KEEP THIS SUBJECT TEMPLATE BYTE-FOR-BYTE — including the literal space before the
  // comma in " , Order ID-". digiCART's existing intake automation, saved views and rules
  // parse it. Do not "fix" the spacing.
  // Only the VALUE changed (M-7): the subject now carries the normalised date, so what used
  // to render as "Order Date: two months ago" is either a real DD-MM-YYYY or the same 'NA'
  // an absent date has always produced. The template itself is untouched.
  const subject =
    `Complaint Date- ${dd}.${mm}.${yyyy}, Order Date: ${toDMY(orderDate.iso)} , ` +
    `Order ID- ${orderId || 'NA'}`;

  const pin = p.pincode != null && String(p.pincode).trim() !== ''
    ? Number(String(p.pincode).replace(/\D/g, '')) : undefined;
  const o = fieldInput(p, orderId, pin);
  const custom_fields = requiredCustomFields(o, now); // throws TicketFieldError — pre-gated below
  const fb = fieldFallbacks(o, now);

  // truTRTL's ceiling fans ARE installed, so unlike the ELLE fork this line stays: it is
  // what tells ops whether a technician visit is even in scope, and it changes what the
  // document-request WhatsApp asks the customer to record.
  const installedLine =
    p.installed === true ? 'Installed: yes' :
    p.installed === false ? 'Installed: no / not applicable' : '';

  // ⭐ M-7. What the caller SAID is kept next to what we FILED whenever the two differ, so
  // ops can re-read a date we resolved loosely ("last January") and correct it from the
  // invoice — and so a date we could not understand at all is visible as a gap rather than
  // disappearing into a cf_order_date placeholder nobody questions.
  const purchaseLine = !said ? ''
    : orderDate.iso
      ? (orderDate.precision === 'exact'
        ? `Purchase date: ${orderDate.iso}`
        : `Purchase date: ${orderDate.iso} (APPROXIMATE — caller said "${said}"; confirm from the invoice)`)
      : `Purchase date: NOT UNDERSTOOD — caller said "${said}". Reconcile from the invoice.`;

  // ⭐ M-2. Both numbers on the ticket, not just the one we filed the contact under.
  const mismatch = callerIdMismatch(p);
  const numbersLine = mismatch
    ? `⚠ Numbers disagree — stated: ${mismatch.stated} | called from: ${mismatch.calledFrom}. `
      + 'Either the caller is reachable on a different line or the stated number was misheard — verify before dispatch.'
    : '';

  // fb.lines says out loud which cf_* values are PLACEHOLDERS rather than data (order date,
  // SKU defaulted, order id "NA", pin 0). Ops reads the description, not our source — and
  // the order-date one can silently misrepresent a warranty window, which runs from the
  // INVOICE date. Warranty must never be assessed off a placeholder order date.
  // ⭐ M-7: these warnings now OPEN the description. They used to sit under the issue text,
  // below the one paragraph every agent actually reads and stops at, which made a warning
  // that exists to prevent a wrong warranty decision invisible at exactly the moment that
  // decision gets made. The number mismatch leads with them for the same reason.
  const description = [
    ...fb.lines,
    numbersLine,
    `Brand: ${config.cf.brandValue}`, // never a literal — CF_BRAND_VALUE is the byte-for-byte truth
    `Product: ${p.product} (${category})`,
    `Platform: ${p.platform}`,
    purchaseLine,
    orderId ? `Order ID: ${orderId}` : '',
    (p.pincode || p.city || p.state)
      ? `Location: ${[p.city, p.state, p.pincode].filter(Boolean).join(', ')}` : '',
    installedLine,
    '',
    `Issue: ${p.issue_description}`,
    '',
    'Logged by AI voice agent (Tara). Invoice + issue video to follow on WhatsApp.',
  ].filter(Boolean).join('\n');

  // This route used to push `issue_description.slice(0, 32)` as a tag, which mints a NEW
  // Freshdesk tag for every unique phrasing a caller uses — tag explosion on a shared
  // tenant (§9.14). Dropped deliberately: the issue text lives in the description, which is
  // where it belongs. Do not re-add it.
  // The brand tag is `brandTag` from lib/config.js — the SAME derivation routes/after-call.js
  // uses — never the literal 'trutrtl' this line used to carry. Two hardcodings of one value
  // is one CF_BRAND_VALUE change away from the two routes tagging this desk differently.
  const tags = ['voice_agent', 'warranty', brandTag];
  if (config.testAutoClose) tags.push('voice_agent_test');

  const payload = {
    name: String(p.name).trim(),
    phone: toStorage(p.phone_number),
    subject,
    description,
    status: FRESHDESK.status.OPEN,
    priority: FRESHDESK.priority.MEDIUM,
    source: FRESHDESK.source.PHONE,
    custom_fields,
    tags,
  };
  if (config.defaultGroupId) payload.group_id = config.defaultGroupId;
  return payload;
}

/** Everything after the gate: create → note → WhatsApp → optional auto-close. */
async function doRegister(p, { category, dedupKey }) {
  const ticket = await fd.createTicket(buildPayload(p, { category }));
  const id = ticket?.id;
  if (!id) throw new Error('no ticket id in response');

  registerDedup.set(dedupKey, id);

  // Private note recording the pending documents.
  try {
    await fd.addNote(
      id,
      `Awaiting invoice + issue video on WhatsApp (${config.companyWhatsapp}).`,
      true,
    );
  } catch (e) {
    logger.warn({ err: e?.message, id }, 'addNote (awaiting docs) failed — ticket still created');
  }

  // ⭐ M-2. A stated number that isn't the number the call came from gets its own private
  // note, carrying both numbers, so it surfaces in the ticket's activity rather than only
  // in a description paragraph. Best-effort like every other note here: the ticket exists
  // and the complaint number is already true, so a failed note must not fail the
  // registration — it is logged instead, where ops can still find it.
  const mismatch = callerIdMismatch(p);
  if (mismatch) {
    try {
      await fd.addNote(
        id,
        `${CALLER_ID_NOTE}. Stated: ${mismatch.stated} | called from: ${mismatch.calledFrom}.`,
        true,
      );
    } catch (e) {
      logger.warn({ err: e?.message, id }, 'addNote (caller_id mismatch) failed — ticket still created');
    }
  }

  // Proactively WhatsApp the customer the document request (per-product instructions +
  // review offer). Best-effort: a WhatsApp failure must NEVER fail the registration — the
  // ticket already exists and the complaint number is already true.
  try {
    const msg = buildDocRequestMessage({
      name: p.name,
      complaintNumber: id,
      productCategory: category,
      platform: mapPlatform(p.platform),
      installed: p.installed,
    });
    // toStorage() first: WHAPI strips to digits, so a bare 10-digit number would go out
    // without the country code. +91xxxxxxxxxx → 91xxxxxxxxxx, which is what WHAPI wants.
    const r = await whapi.sendText(toStorage(p.phone_number), msg);
    if (r?.ok) {
      try {
        await fd.addNote(id, 'Document-request WhatsApp sent to the customer (invoice + video + review-for-extension offer).', true);
      } catch { /* note is informational only */ }
    }
  } catch (e) {
    logger.warn({ err: e?.message, id }, 'whapi doc-request send failed (ticket still created)');
  }

  // TEST SAFETY: immediately close test tickets so live ops isn't disturbed.
  if (config.testAutoClose) {
    try {
      await fd.updateTicket(id, { status: FRESHDESK.status.CLOSED });
      logger.info({ id }, 'TEST_AUTO_CLOSE: test ticket closed');
    } catch (e) {
      logger.warn({ err: e?.message, id }, 'TEST_AUTO_CLOSE close failed');
    }
  }

  logger.info({ id, category, test: config.testAutoClose }, 'register-complaint created');
  return { complaint_number: String(id) };
}

// ⭐ RACE FIX (§9.14). The old code wrote the dedup entry AFTER createTicket resolved but
// checked it before → two concurrent retries (Ravan re-firing a slow call) both created a
// ticket. Here the in-flight promise is registered SYNCHRONOUSLY, in the same tick as the
// check, so a concurrent duplicate joins the first create instead of racing it. Cleared on
// settle: a failed attempt must never block a genuine retry.
const inFlight = new Map(); // dedupKey -> Promise<{complaint_number}>

registerComplaintRouter.post('/freshdesk/register-complaint', requireBearer, async (req, res) => {
  const p = unwrapParams(req.body);

  const missing = REQUIRED.filter((k) => !p[k] || !String(p[k]).trim());
  if (missing.length) {
    // 200, not the old 400 — same never-500/always-voice-shaped contract as every other
    // answer on this route. Ravan hands non-200s to Tara as a generic tool failure, which
    // is exactly when she is most likely to improvise.
    logger.warn({ missing }, 'register-complaint: missing required params');
    return res.json(fail('missing_required', { missing }));
  }

  // ── ⭐ M-2 PHONE GATE — before the honest-failure gate, and before ANY write ──
  //
  // Asked first because it is the cheapest question to re-ask and the most expensive one to
  // get wrong: every downstream promise on this call (the callback, the document-request
  // WhatsApp, the invoice, the video) is delivered to this number and to nothing else.
  // toStorage() cannot tell us anything here — it takes the last ten digits of ANY input
  // and prefixes +91, so "double nine eight" and a nine-digit number both come out looking
  // like perfectly good mobile numbers. isValidIndianMobile() is the check that was already
  // guarding complaint-status.js:72 and had simply never been wired into the route that
  // WRITES. Recoverable: Tara asks for it digit by digit and calls again.
  if (!isValidIndianMobile(p.phone_number)) {
    logger.warn(
      { heard: maskPhone(String(p.phone_number)), digits: tenDigit(p.phone_number).length },
      'register-complaint: refusing to file — the number as heard is not a valid Indian mobile',
    );
    return res.json(fail('invalid_phone'));
  }

  // ── ⭐ THE HONEST-FAILURE GATE — decided BEFORE any write ──
  //
  // validateComplaint() is the single source of truth for whether this complaint can be
  // filed TRUTHFULLY (lib/ticket-fields.js owns the CRM reality; this route owns what Tara
  // says about it). It is the non-throwing twin of requiredCustomFields(), so the create
  // below can no longer surprise us. It catches four things:
  //
  //   unknown_product     — mapCategory() isn't sure. A guess here is a real ticket against
  //                         the wrong product, so we ask again instead.
  //   category_unavailable— ⭐ THE ONE THAT MATTERS. cf_brand121540 is a chain Freshdesk
  //                         validates (Brand → Category → SKU), and truTRTL has EIGHT
  //                         categories against ELEVEN products in the cf_custom_tags
  //                         dropdown. Induction, Cooker and Iron have NO node, so the create
  //                         WOULD 400. We don't attempt it, and we don't fabricate the
  //                         category that would make it succeed — an Induction complaint
  //                         filed as a Ceiling Fan with model 'Trutrtl-Smart-1200 MM' is
  //                         worse than no ticket, because ops schedules technicians off
  //                         those fields. Tara takes a callback instead of reading back a
  //                         number for a complaint that does not exist.
  //                         ⭐ 2026-07-20 — this is now the PERMANENT answer, not a wait.
  //                         Manish confirmed truTRTL does not sell induction cooktops,
  //                         pressure cookers or irons ("not part of our current product
  //                         range"), so F-3 was withdrawn: no admin is coming to add these
  //                         nodes, and none should. The callback IS the correct outcome.
  //   unknown_platform    — never default to Website (§9.1 🟠 #8). Website is the value that
  //                         decides which return policy applies and which invoice we ask
  //                         for; defaulting to it silently rewrites the customer's rights.
  //                         There is no "Other" option on cf_purchased_from, so we ask again.
  //   unmapped_channel    — ⭐ Meesho and Jabong are LEGACY truTRTL channels (named on an
  //                         older "Sold on" list) with no cf_purchased_from value at all.
  //                         Asking again cannot fix it — there is no right answer to give —
  //                         so it is terminal. ⭐ 2026-07-20: the client's current buy list
  //                         (Amazon, Flipkart, Swiggy Instamart, Blinkit, Zepto, JioMart,
  //                         BigBasket, truTRTL.com) does NOT include either, so this is
  //                         permanent too and F-5 was withdrawn as written. Only legacy
  //                         owners still in warranty land here. ⚠ When they do, whoever
  //                         works the UNFILED log must capture the PURCHASE MONTH/YEAR by
  //                         hand — there is no ticket to carry the warranty clock.
  const check = validateComplaint(fieldInput(p, (p.order_id ?? '').toString().trim(), undefined));
  if (!check.ok) {
    const reason = REASON_BY_CODE[check.code] || 'freshdesk_error';
    const category = mapCategory(p.product);
    if (TERMINAL.has(reason)) {
      logUnfiled(reason, p, category); // the only record ops will have
    } else {
      logger.warn(
        { reason, code: check.code, field: check.field, product_said: String(p.product || ''), platform_said: String(p.platform || '') },
        `register-complaint: refusing to file — ${check.message}`,
      );
    }
    return res.json(fail(reason));
  }

  const category = mapCategory(p.product); // proven non-null + available by validateComplaint

  // ── Dedup ──
  // ⭐ #5 FIX: the key now includes the normalised issue. Keying on phone+product alone
  // meant a caller's legitimate SECOND complaint inside the 5-minute window got the FIRST
  // ticket's id back — with no ticket, no note, no WhatsApp — while Tara read it out as
  // new. That is an honesty violation committed by the middleware, not the model.
  const dedupKey = normalizeKey('reg', tenDigit(p.phone_number), category, issueKey(p.issue_description));

  const existing = registerDedup.get(dedupKey);
  if (existing) {
    logger.info({ reused: true, id: existing }, 'register-complaint deduped (same phone+category+issue)');
    return res.json({ complaint_number: String(existing) });
  }

  let work = inFlight.get(dedupKey);
  if (!work) {
    work = doRegister(p, { category, dedupKey }).finally(() => inFlight.delete(dedupKey));
    inFlight.set(dedupKey, work); // synchronous: no await between the get and the set
  }

  try {
    return res.json(await work);
  } catch (err) {
    // requiredCustomFields() throws TicketFieldError for exactly what validateComplaint()
    // already cleared above, so this should be unreachable — but if the two ever drift,
    // report the REAL reason rather than blaming Freshdesk for our own refusal.
    const reason = err instanceof TicketFieldError
      ? (REASON_BY_CODE[err.code] || 'freshdesk_error')
      : 'freshdesk_error';
    logger.error({ err: err?.message, reason, category }, 'register-complaint failed');
    logUnfiled(reason, p, category); // the complaint still must not vanish
    return res.json(fail(reason));
  }
});
