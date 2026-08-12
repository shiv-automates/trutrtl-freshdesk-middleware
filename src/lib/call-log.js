// One structured row per completed call → a Google Sheet, so the team can review every call
// (duration, resolution, action, callback-or-note, transcript, recording) WITHOUT listening to
// audio. Delivery is via a Google Apps Script Web App (free, no service-account keys): the
// middleware POSTs this JSON row to CALL_LOG_SHEET_URL and the script appends it as a row.
//
// Best-effort by contract: a Sheet failure must NEVER affect the call, the Freshdesk note, or
// the webhook response. Runs backgrounded, swallows everything.
import { logger } from './logger.js';
import { renderTranscript } from './ravan.js';

const SHEET_URL = process.env.CALL_LOG_SHEET_URL || '';
const SHEET_SECRET = process.env.CALL_LOG_SHEET_SECRET || ''; // optional shared secret the script checks

export const callLogEnabled = () => !!SHEET_URL;

/** Whole seconds → "m:ss" for the human-facing "Duration" column. */
export function mmss(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The flat row. Key ORDER here is the column order the Apps Script writes, so keep it stable —
 * reordering or renaming a key silently shifts every future row's columns.
 */
export function buildCallRow(call, nowIso) {
  return {
    time: nowIso || '',
    call_id: call.callId || '',
    caller_number: call.phone || '',
    duration: mmss(call.durationSec),
    duration_sec: call.durationSec == null ? '' : String(call.durationSec),
    // These four are the columns the QA team reads instead of listening. They populate once
    // Agni's Post-Call Data Extraction is configured with the matching custom fields; until
    // then they're blank and `summary` carries the gist.
    disposition: call.disposition || '',
    resolution: call.resolution || '',
    action_to_take: call.actionToTake || call.nextSteps || '',
    callback_needed: call.callbackNeeded == null ? '' : String(call.callbackNeeded),
    product: call.product || '',
    sentiment: call.sentiment || '',
    disconnect_reason: call.disconnectReason || '',
    summary: call.summary || '',
    recording_url: call.recordingUrl || '',
    // Google Sheets caps a cell at 50,000 chars; keep well under it.
    transcript: renderTranscript(call.transcripts, 45000),
  };
}

/**
 * Append one call to the Sheet. Never throws; returns a small status object for the caller's log.
 * The caller should NOT await this on the response path — fire it in the background.
 */
export async function logCallToSheet(call, nowIso) {
  if (!SHEET_URL) return { ok: false, skipped: 'no CALL_LOG_SHEET_URL' };
  const row = buildCallRow(call, nowIso);
  if (SHEET_SECRET) row.secret = SHEET_SECRET;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(SHEET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
        signal: ctrl.signal,
        redirect: 'follow', // Apps Script Web Apps answer on a 302 → script.googleusercontent.com
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      logger.warn({ status: r.status, callId: call.callId }, 'call-log: Sheet POST returned non-2xx (call unaffected)');
      return { ok: false, status: r.status };
    }
    logger.info({ callId: call.callId }, 'call-log: row appended to Sheet');
    return { ok: true };
  } catch (e) {
    logger.warn({ err: e?.message, callId: call.callId }, 'call-log: Sheet POST failed (call unaffected)');
    return { ok: false, err: e?.message };
  }
}
