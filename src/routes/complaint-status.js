// POST /freshdesk/complaint-status
// Input : { complaint_number?, phone_number?, caller_stated_name? }  (at least one identifier)
// Output: ALWAYS HTTP 200. Either the voice-ready status shape or { found:false }.
//
// The two guardrails this route shipped without (dossier §9.1 🔴 #1):
//   1. THE BRAND FILTER. digicart.freshdesk.com is ONE desk shared by FOUR brands
//      (MILTON, APARNA, FKSB, truTRTL) over ONE ticket-id sequence. Any ticket we
//      fetch must prove it is truTRTL's before a single field of it is formatted.
//   2. THE IDENTITY GATE. The caller's stated name is compared to the requester
//      SERVER-SIDE (in formatStatus) and reduced to a boolean, so the guardrail is
//      enforced by code rather than by prompt discipline — and the real name never
//      enters Tara's context.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireBearer } from '../lib/auth.js';
import * as fd from '../lib/freshdesk.js';
import { unwrapParams, formatStatus, notFound, isBrandTicket } from '../lib/ravan.js';
import { isClosed } from '../lib/status-map.js';
import { statusCache } from '../lib/stores.js';
import { tenDigit, isValidIndianMobile } from '../lib/phone.js';

export const complaintStatusRouter = Router();

// A missing identifier used to answer with a bare 400 while every other failure on
// this route is a 200 — an inconsistency nobody has verified Ravan handles (§9.14).
// One shape, one status code, always something Tara can say.
const missingIdentifier = () => ({
  found: false,
  error: true,
  reason: 'missing_identifier',
  spoken_hint: 'Could you give me your complaint number, or the mobile number your complaint is registered with?',
});

complaintStatusRouter.post('/freshdesk/complaint-status', requireBearer, async (req, res) => {
  const params = unwrapParams(req.body);
  const complaintNumber = (params.complaint_number ?? params.complaintNumber ?? '').toString().trim();
  const phoneNumber = (params.phone_number ?? params.phoneNumber ?? '').toString().trim();
  const callerStatedName = (
    params.caller_stated_name ?? params.callerStatedName ?? params.stated_name ?? ''
  ).toString().trim();

  if (!complaintNumber && !phoneNumber) {
    logger.info('complaint-status: called with no identifier');
    return res.json(missingIdentifier()); // 200, never 400
  }

  // ⚠ The cache is keyed per (identifier + BRAND) so a cached entry can never carry a
  // cross-brand hit past the filter, and we cache the TICKET rather than the formatted
  // payload — the payload embeds `name_matches`, which is specific to the name THIS
  // caller stated. Caching the payload would let a second caller inherit the first
  // caller's passed identity gate. Only brand-verified tickets are ever stored.
  // (TTL comes from STATUS_CACHE_TTL_MS via lib/stores.js; the desk allows only
  //  ~40 req/min account-wide, shared with other automation.)
  const cacheKey = `${config.cf.brandValue}|` +
    (complaintNumber ? `id:${complaintNumber}` : `ph:${tenDigit(phoneNumber)}`);

  try {
    let ticket = statusCache.get(cacheKey) || null;
    const cacheHit = !!ticket;

    if (!ticket) {
      if (complaintNumber) {
        if (config.complaintIdMode === 'CUSTOM_FIELD' && config.complaintIdField) {
          const hits = await fd.searchTicketsByCustomField(config.complaintIdField, complaintNumber);
          ticket = hits[0] ? await fd.getTicket(hits[0].id) : null;
        } else {
          // sanitise: ticket ids are numeric
          const id = complaintNumber.replace(/[^\d]/g, '');
          ticket = id ? await fd.getTicket(id) : null;
        }
      } else if (isValidIndianMobile(phoneNumber)) {
        // Only search for a plausible 10-digit Indian mobile (6-9 start). This avoids
        // junk/placeholder numbers (e.g. 0000000000) matching a stray contact.
        const contact = await fd.searchContacts(phoneNumber);
        if (contact?.id) {
          const tickets = await fd.getTicketsByRequester(contact.id);
          // ⭐ BRAND FILTER (by-phone path). The same person can hold MILTON, APARNA or
          // FKSB tickets on this shared desk — filter BEFORE choosing newest-non-closed,
          // or "your latest complaint" becomes another brand's complaint. If the list
          // endpoint ever stops returning custom_fields this filters everything out:
          // found:false. Failing closed is the only acceptable direction here.
          const ours = tickets.filter(isBrandTicket);
          const pick = ours.find((t) => !isClosed(t.status)) || ours[0] || null;
          // list endpoint omits conversations — fetch the full ticket for the note
          // (getTicket defaults to include=conversations,requester,stats, so the
          //  requester the identity gate reads is on the object we hand to formatStatus)
          if (pick) ticket = await fd.getTicket(pick.id);
        }
      }

      // ⭐ BRAND FILTER (by-id path, and a re-check of the fetched by-phone ticket).
      // A caller reading out any ~5-digit number lands on SOME brand's ticket. Return
      // exactly what a genuine miss returns: { found:false }. We do not say "that's not
      // yours", we do not log it as an error against the caller — we do not disclose
      // that the ticket exists at all, because that is itself information about another
      // brand's customer.
      if (ticket && !isBrandTicket(ticket)) {
        logger.warn(
          { ticketId: ticket.id, by: complaintNumber ? 'number' : 'phone' },
          'complaint-status: ticket belongs to another brand on the shared desk — answering found:false',
        );
        ticket = null;
      }

      if (ticket) statusCache.set(cacheKey, ticket);
    }

    // ⭐ C1: a by-PHONE lookup is identity-proven by phone + brand (the caller possesses the
    // registered mobile and isBrandTicket() has proven the ticket is truTRTL's), so the name
    // check relaxes to a soft signal there. A by-ID lookup keeps the (now fuzzy) hard gate.
    const byPhone = !complaintNumber && !!phoneNumber;
    const payload = ticket
      ? formatStatus(ticket, { callerStatedName, phoneVerified: byPhone })
      : notFound();
    logger.info(
      {
        found: payload.found,
        by: complaintNumber ? 'number' : 'phone',
        name_matches: payload.name_matches ?? null,
        name_given: !!callerStatedName,
        cacheHit,
      },
      'complaint-status',
    );
    return res.json(payload);
  } catch (err) {
    logger.error({ err: err?.message }, 'complaint-status failed — degrading to found:false');
    return res.json(notFound()); // never 500 to the voice agent
  }
});
