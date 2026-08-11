// POST /ravan/after-call
// Ravan's end-of-call webhook. Logs the call into Freshdesk: add a private note to the
// caller's most recent truTRTL ticket, or create a voice_agent ticket if there isn't one
// AND we genuinely know what it is about.
// ALWAYS returns HTTP 200 { ok:true } so Ravan never retry-storms us (the only exception
// is the 401 below, which is a refusal to accept the request at all, not a failure to
// process one — Ravan retrying an unauthorised call would never start succeeding).
//
// Three defects fixed here, plus the brand filter this route never had:
//   ⭐ §9.1 #7 THE AUTH HOLE. The guard only fired when ?key was PRESENT, so omitting the
//      param entirely walked straight through into a live production helpdesk.
//   ⭐ §9.1 #2 NO FABRICATED PRODUCT. This route called requiredCustomFields({}), stamping
//      EVERY auto-created after-call ticket with Ceiling Fans / Trutrtl-Smart-1200 MM /
//      Website / today — fields ops routes technicians off.
//   ⭐ §9.14 The dedup mark now happens AFTER the work, not before it.
//   ⭐ §9.1 #1 The requester's ticket list is filtered to OUR brand before we write to it.
import { Router } from 'express';
import { config, brandTag, FRESHDESK } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { safeEqual } from '../lib/auth.js';
import * as fd from '../lib/freshdesk.js';
import { parseAfterCall, renderTranscript, isBrandTicket } from '../lib/ravan.js';
import { requiredCustomFields, validateComplaint, fieldFallbacks } from '../lib/ticket-fields.js';
import { mapCategory } from '../lib/product-map.js';
import { isClosed } from '../lib/status-map.js';
import { toStorage, tenDigit } from '../lib/phone.js';
import { callDedup } from '../lib/stores.js';

export const afterCallRouter = Router();

// A "TEMP" raw-shape logger was shipped here to reverse-engineer Ravan's payload and has
// been running in production for over a month. Kept, but behind a flag that defaults to
// FALSE — turn it on for the first live webhook, read the shape, turn it off.
// (Read straight from env: lib/config.js belongs to another workstream. Fold it into
//  config.js when the two branches merge.)
const LOG_RAW_WEBHOOK = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.LOG_RAW_WEBHOOK || '').toLowerCase());

// Guards a redelivery that arrives WHILE the first one is still being processed — the
// window that opens up now that we only mark dedup after success.
const inFlightCalls = new Set();

// Brand tag for auto-created tickets: `brandTag` in lib/config.js, derived there from
// cf.brandValue and shared with routes/register-complaint.js. It used to be derived here
// and hardcoded there, which meant changing CF_BRAND_VALUE made the two routes disagree.

afterCallRouter.post('/ravan/after-call', async (req, res) => {
  // ⭐ #7 FIX. Was: `if (secret && req.query.key && req.query.key !== secret) → 401` — the
  // middle clause meant NO ?key at all passed the guard, so anyone who learned this URL
  // could POST arbitrary notes and tickets into a live helpdesk shared by four brands.
  // Now: if a secret is configured the key must be PRESENT AND MATCH, compared with the
  // same constant-time helper as the Bearer routes.
  if (config.ravanSharedSecret) {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!safeEqual(key, config.ravanSharedSecret)) {
      logger.warn({ hadKey: !!key }, 'after-call: rejected — missing or wrong ?key');
      return res.status(401).json({ ok: false });
    }
  }

  const call = parseAfterCall(req.body);

  if (LOG_RAW_WEBHOOK) {
    logger.info({
      bodyKeys: Object.keys(req.body || {}),
      dataKeys: req.body && req.body.data ? Object.keys(req.body.data) : null,
      gotPhone: !!call.phone, gotCallId: !!call.callId, gotProduct: !!call.product,
    }, 'after-call received (raw shape)');
    // TEMP (2026-08 transcript audit): dump the full body, truncated, so we can see the
    // real caller_number / transcript / summary field shapes Agni actually sends. Remove
    // once the payload contract is confirmed and the pipeline is wired.
    try {
      logger.info({ rawBody: JSON.stringify(req.body).slice(0, 12000) }, 'after-call RAW BODY (temp audit)');
    } catch { /* body not serialisable — ignore */ }
  }

  const dedupKey = call.callId ? `call:${call.callId}` : null;
  if (dedupKey && (callDedup.has(dedupKey) || inFlightCalls.has(dedupKey))) {
    return res.json({ ok: true, deduped: true });
  }
  if (dedupKey) inFlightCalls.add(dedupKey);

  // Acknowledge immediately, then do Freshdesk work without blocking the response.
  res.json({ ok: true });

  try {
    let ticketId = null;
    if (call.phone) {
      const contact = await fd.searchContacts(call.phone);
      if (contact?.id) {
        const tickets = await fd.getTicketsByRequester(contact.id);
        // ⭐ Brand filter: one contact can hold MILTON/APARNA/FKSB/truTRTL tickets on this
        // shared desk. A truTRTL call summary — transcript and all — must never be written
        // onto another brand's ticket, where their agents would read it.
        const ours = tickets.filter(isBrandTicket);
        const open = ours.find((t) => !isClosed(t.status)) || ours[0];
        ticketId = open?.id || null;
      }
    }

    const transcript = renderTranscript(call.transcripts);
    const noteBody = [
      `[Post-call summary — AI voice agent]`,
      call.callId ? `Call ID: ${call.callId}` : '',
      call.durationSec ? `Duration: ${call.durationSec}s` : '',
      `Sentiment: ${call.sentiment}`,
      call.disposition ? `Disposition: ${call.disposition}` : '',
      '',
      `Summary: ${call.summary || '(none provided)'}`,
      call.nextSteps ? `Next steps: ${call.nextSteps}` : '',
      call.recordingUrl ? `Recording: ${call.recordingUrl}` : '',
      transcript ? `\nTranscript:\n${transcript}` : '',
    ].filter(Boolean).join('\n');

    if (ticketId) {
      // Preferred path by a distance: attach to the real ticket. It needs no product
      // guess, so it can never fabricate one.
      await fd.addNote(ticketId, noteBody, true);
      logger.info({ ticketId, callId: call.callId }, 'after-call note added');
    } else if (call.phone) {
      // ⭐ #2 FIX. Creating a ticket here means filling cf_brand121540 → cf_product_category
      // → cf_product, a chain Freshdesk validates. This route used to solve that by calling
      // requiredCustomFields({}) and letting the old `|| 'Ceiling Fans'` fallback fire, so
      // every after-call ticket carried a product the caller never mentioned — and ops
      // routes technicians off those fields. lib/ticket-fields.js now THROWS instead of
      // defaulting, so that call would blow up here anyway.
      //
      // The rule now: no product, no ticket. We only use a product/platform Ravan states
      // EXPLICITLY (parseAfterCall never infers them from the summary or transcript), and
      // only if lib/ticket-fields.js can fill every required field truthfully. Anything
      // else and we log loudly and skip — a missing ticket is visible in this log; a ticket
      // stamped with a fabricated product is invisible forever, because it looks correct.
      //
      // ⚠ In practice this means a pure-enquiry call from an unknown number is LOGGED, not
      // ticketed: cf_purchased_from is required on create and Ravan rarely states a
      // platform, so validateComplaint refuses. That is the honest cost of not defaulting
      // to Website. The common case is unaffected — if Tara registered a complaint on the
      // call, the ticket already exists and the note path above runs.
      const check = validateComplaint({ product: call.product, platform: call.platform });
      if (!check.ok) {
        logger.warn({
          callId: call.callId,
          callback_number: String(call.phone || ''), // logged so ops can call this customer back
          code: check.code,
          product_said: call.product || null,
          category_mapped: call.product ? mapCategory(call.product) : null,
          platform_said: call.platform || null,
          summary: String(call.summary || '').slice(0, 500),
          recording: call.recordingUrl || null,
        }, `after-call: no ${config.cf.brandValue} ticket for this caller and cannot file one truthfully (${check.code}) — NOT creating one (refusing to stamp a fabricated product). Log this call by hand.`);
        // A terminal decision, not a failure: a redelivery would reach the same answer, so
        // mark it done rather than re-spending the shared ~40 req/min budget on it.
        if (dedupKey) callDedup.set(dedupKey, true);
        return;
      }

      const { dd, mm, yyyy } = (() => {
        const f = new Intl.DateTimeFormat('en-GB', {
          timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const [d, m, y] = f.format(new Date()).split('/');
        return { dd: d, mm: m, yyyy: y };
      })();
      // ⭐ SAY WHICH FIELDS ARE PLACEHOLDERS. This route hands requiredCustomFields() a
      // product and a platform and NOTHING else — no order date, no order id, no location,
      // no model — so the ticket it creates carries cf_order_date = 1900-01-01 (the
      // ORDER_DATE_NOT_CAPTURED sentinel), cf_order_id 'NA', cf_pin_code 0 and a defaulted
      // SKU. routes/register-complaint.js explains all of that in its description; this
      // route did not, so ops met a 1900 purchase date with zero context — on exactly the
      // tickets nobody was expecting, since these are auto-created after the call ends.
      // Same input object as requiredCustomFields() below, or the warnings would describe
      // fields this ticket does not actually have.
      const fieldInput = { product: call.product, platform: call.platform };
      const fb = fieldFallbacks(fieldInput);
      // Warnings OPEN the description, exactly as in register-complaint.js: warranty runs
      // from the invoice date and gets decided off cf_order_date, so the line saying that
      // field is a sentinel must be above the paragraph an agent reads and stops at.
      const description = fb.lines.length ? `${fb.lines.join('\n')}\n\n${noteBody}` : noteBody;

      const payload = {
        name: call.callerName || `Caller ${tenDigit(call.phone).slice(-4) || 'unknown'}`,
        phone: toStorage(call.phone),
        subject: `Inbound AI call — ${dd}.${mm}.${yyyy}`,
        description,
        status: FRESHDESK.status.OPEN,
        priority: FRESHDESK.priority.MEDIUM,
        source: FRESHDESK.source.PHONE,
        // Pre-cleared by validateComplaint() above, so this cannot throw and cannot
        // fabricate: every value here traces to something Ravan actually stated.
        custom_fields: requiredCustomFields(fieldInput),
        tags: ['voice_agent', 'inbound_call', brandTag, `sentiment_${call.sentiment}`.slice(0, 32)],
      };
      if (config.defaultGroupId) payload.group_id = config.defaultGroupId;
      const t = await fd.createTicket(payload);
      logger.info({ ticketId: t?.id, callId: call.callId }, 'after-call ticket created');
    } else {
      logger.warn({ callId: call.callId }, 'after-call: no phone and no existing ticket — skipped (cannot create a ticket without a requester)');
    }

    // ⭐ Mark ONLY after the work succeeded (§9.14). This used to be marked before it, so if
    // the Freshdesk work threw, Ravan's redelivery inside the 5-minute window was answered
    // { ok:true, deduped:true } and the call was lost permanently — the failure erased the
    // only chance to retry it.
    if (dedupKey) callDedup.set(dedupKey, true);
  } catch (err) {
    logger.error({ err: err?.message, callId: call.callId }, 'after-call processing failed (already 200-acked) — not marked as done, a redelivery may retry');
  } finally {
    if (dedupKey) inFlightCalls.delete(dedupKey);
  }
});
