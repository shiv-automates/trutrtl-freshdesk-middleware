// POST /freshdesk/complaint-status
// Input : { complaint_number?, phone_number? }  (at least one)
// Output: always HTTP 200. Either the voice-ready status shape or { found:false }.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireBearer } from '../lib/auth.js';
import * as fd from '../lib/freshdesk.js';
import { unwrapParams, formatStatus, notFound } from '../lib/ravan.js';
import { isClosed } from '../lib/status-map.js';
import { statusCache } from '../lib/stores.js';
import { tenDigit, isValidIndianMobile } from '../lib/phone.js';

export const complaintStatusRouter = Router();

complaintStatusRouter.post('/freshdesk/complaint-status', requireBearer, async (req, res) => {
  const params = unwrapParams(req.body);
  const complaintNumber = (params.complaint_number ?? params.complaintNumber ?? '').toString().trim();
  const phoneNumber = (params.phone_number ?? params.phoneNumber ?? '').toString().trim();

  if (!complaintNumber && !phoneNumber) {
    return res.status(400).json({ error: 'complaint_number or phone_number is required' });
  }

  // cache key for repeat lookups within a call
  const cacheKey = complaintNumber ? `id:${complaintNumber}` : `ph:${tenDigit(phoneNumber)}`;
  const cached = statusCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    let ticket = null;

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
        // newest non-closed; fall back to newest overall
        ticket = tickets.find((t) => !isClosed(t.status)) || tickets[0] || null;
        // list endpoint omits conversations — fetch the full ticket for the note
        if (ticket) ticket = await fd.getTicket(ticket.id);
      }
    }

    const payload = ticket ? formatStatus(ticket) : notFound();
    if (payload.found) statusCache.set(cacheKey, payload);
    logger.info({ found: payload.found, by: complaintNumber ? 'number' : 'phone' }, 'complaint-status');
    return res.json(payload);
  } catch (err) {
    logger.error({ err: err?.message }, 'complaint-status failed — degrading to found:false');
    return res.json(notFound()); // never 500 to the voice agent
  }
});
