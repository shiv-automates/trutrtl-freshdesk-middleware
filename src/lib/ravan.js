// Helpers for talking to the Ravan/Agni voice agent:
//  - defensive parsing of request bodies (Ravan's exact contract is undocumented,
//    so accept both flat params and a wrapped {args}/{parameters} envelope)
//  - the "safe note" rule for what Tara may read aloud
//  - voice-friendly response formatting
//  - lenient parsing of the after-call webhook payload
import { config } from './config.js';
import { stripHtml, toOneSentence } from './html-strip.js';
import { statusLabel, nextStep } from './status-map.js';
import { daysSince } from './time-since.js';

/** Unwrap {args}/{parameters} envelopes; otherwise return the body as-is. */
export function unwrapParams(body) {
  if (body && typeof body === 'object') {
    if (body.args && typeof body.args === 'object') return body.args;
    if (body.parameters && typeof body.parameters === 'object') return body.parameters;
  }
  return body || {};
}

/**
 * Decide the spoken "latest update". Per product decision: only read a note that
 * is clearly customer-facing — a public reply, or a private note that is addressed
 * to the customer ("Dear Customer …"). Internal/terse notes are NOT read aloud.
 * Returns trimmed text or null.
 */
export function safeLatestNote(conversations) {
  if (!Array.isArray(conversations) || !conversations.length) return null;
  const sorted = [...conversations].sort(
    (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
  );
  for (const c of sorted) {
    const text = stripHtml(c.body_text || c.body || '');
    if (!text) continue;
    const isPublic = c.private === false || c.incoming === true;
    const addressedToCustomer = /^\s*(dear|hi|hello)\b.*\bcustomer\b/i.test(text) ||
      /^\s*dear\s+customer/i.test(text);
    if (isPublic || addressedToCustomer) {
      return toOneSentence(text, 220);
    }
  }
  return null;
}

/**
 * Build the voice-ready status response from a Freshdesk ticket.
 * Always returns the agreed shape; missing pieces are simply omitted.
 */
export function formatStatus(ticket) {
  if (!ticket) return { found: false };
  const cf = ticket.custom_fields || {};
  const status = Number(ticket.status);
  const out = {
    found: true,
    complaint_number: String(ticket.id),
    status_label: statusLabel(status),
    days_since_registered: daysSince(ticket.created_at, config.timezone),
    expected_next_step: nextStep(status),
  };
  const product = cf[config.cf.product] || cf[config.cf.productCategory];
  if (product) out.product = product;
  const note = safeLatestNote(ticket.conversations);
  if (note) out.latest_update = note;
  return out;
}

export const notFound = () => ({ found: false });

// ── After-call webhook parsing ───────────────────────────────────────────────

const firstOf = (...vals) => vals.find((v) => v != null && v !== '');

/** Pull the fields we care about out of Ravan's (loosely-known) after-call payload. */
export function parseAfterCall(body) {
  const b = body || {};
  const d = b.data && typeof b.data === 'object' ? b.data : b;
  const pca = d.post_call_analysis || d.analysis || {};

  const transcripts = Array.isArray(d.transcripts)
    ? d.transcripts
    : Array.isArray(d.transcript)
      ? d.transcript
      : [];

  return {
    callId: firstOf(d.call_session_id, d.call_id, d.callId, b.call_session_id, b.id) || null,
    phone: firstOf(d.phone, d.caller_number, d.from, d.from_number, d.customer_number) || null,
    callerName: firstOf(d.caller_name, d.customer_name, d.name) || null,
    summary: firstOf(d.summary, pca.summary, b.summary) || '',
    sentiment: firstOf(pca.sentiment, d.sentiment, b.sentiment) || 'neutral',
    disposition: firstOf(pca.disposition, d.disposition) || null,
    nextSteps: firstOf(pca.next_steps, d.next_steps) || null,
    recordingUrl: firstOf(d.recording_url, d.recording, b.recording_url) || null,
    durationSec: firstOf(d.duration_sec, d.duration) || null,
    status: firstOf(d.status, b.status) || null,
    transcripts,
  };
}

/** Render a transcript array into a compact text block, capped in length. */
export function renderTranscript(transcripts, maxChars = 2500) {
  if (!Array.isArray(transcripts) || !transcripts.length) return '';
  const lines = [];
  for (const t of transcripts) {
    if (typeof t === 'string') { lines.push(t); continue; }
    const role = (t.role || t.speaker || '').toUpperCase();
    const content = t.message?.content ?? t.content ?? t.text ?? '';
    if (content) lines.push(role ? `${role}: ${content}` : content);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…(truncated)';
  return out;
}
