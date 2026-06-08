// POST /ravan/after-call
// Ravan's end-of-call webhook. Logs the call into Freshdesk: add a private note to
// the caller's most recent ticket, or create a new voice_agent ticket if none.
// ALWAYS returns HTTP 200 { ok:true } so Ravan never retry-storms us.
//
// No Bearer auth here (Ravan webhooks don't send our shared secret); security relies
// on the obscure URL + Ravan's sender. An optional ?key= guard is supported below.
import { Router } from 'express';
import { config, FRESHDESK } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import * as fd from '../lib/freshdesk.js';
import { parseAfterCall, renderTranscript } from '../lib/ravan.js';
import { requiredCustomFields } from '../lib/ticket-fields.js';
import { isClosed } from '../lib/status-map.js';
import { toStorage, tenDigit } from '../lib/phone.js';
import { callDedup } from '../lib/stores.js';

export const afterCallRouter = Router();

afterCallRouter.post('/ravan/after-call', async (req, res) => {
  // Optional shared-secret via query (?key=) if you choose to configure it in Ravan.
  if (config.ravanSharedSecret && req.query.key && req.query.key !== config.ravanSharedSecret) {
    return res.status(401).json({ ok: false });
  }

  const call = parseAfterCall(req.body);

  // Dedup re-delivered webhooks.
  if (call.callId) {
    if (callDedup.has(`call:${call.callId}`)) {
      return res.json({ ok: true, deduped: true });
    }
    callDedup.set(`call:${call.callId}`, true);
  }

  // Acknowledge immediately, then do Freshdesk work without blocking the response.
  res.json({ ok: true });

  try {
    let ticketId = null;
    if (call.phone) {
      const contact = await fd.searchContacts(call.phone);
      if (contact?.id) {
        const tickets = await fd.getTicketsByRequester(contact.id);
        const open = tickets.find((t) => !isClosed(t.status)) || tickets[0];
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
      await fd.addNote(ticketId, noteBody, true);
      logger.info({ ticketId, callId: call.callId }, 'after-call note added');
    } else {
      const { dd, mm, yyyy } = (() => {
        const f = new Intl.DateTimeFormat('en-GB', {
          timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const [d, m, y] = f.format(new Date()).split('/');
        return { dd: d, mm: m, yyyy: y };
      })();
      const payload = {
        name: call.callerName || (call.phone ? `Caller ${tenDigit(call.phone).slice(-4)}` : 'Unknown caller'),
        subject: `Inbound AI call — ${dd}.${mm}.${yyyy}`,
        description: noteBody,
        status: FRESHDESK.status.OPEN,
        priority: FRESHDESK.priority.MEDIUM,
        source: FRESHDESK.source.PHONE,
        custom_fields: requiredCustomFields({}),
        tags: ['voice_agent', 'inbound_call', `sentiment_${call.sentiment}`.slice(0, 32)],
      };
      if (call.phone) payload.phone = toStorage(call.phone);
      if (config.defaultGroupId) payload.group_id = config.defaultGroupId;
      const t = await fd.createTicket(payload);
      logger.info({ ticketId: t?.id, callId: call.callId }, 'after-call ticket created');
    }
  } catch (err) {
    logger.error({ err: err?.message, callId: call.callId }, 'after-call processing failed (already 200-acked)');
  }
});
