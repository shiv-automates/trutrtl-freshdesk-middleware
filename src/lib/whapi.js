// WHAPI (whapi.cloud) client — sends a WhatsApp text from the truTRTL channel to a customer.
// Gated on WHAPI_ENABLED so it is a no-op until the token/channel is wired. Never throws;
// callers treat failures as best-effort (a registration must never fail because WhatsApp is down).
import { config } from './config.js';
import { logger } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a plain-text WhatsApp message.
 * @param {string} toNumber  recipient phone (any format; normalised to digits)
 * @param {string} body      message text
 * @returns {Promise<{ok?:boolean, skipped?:boolean, error?:boolean, status?:number}>}
 */
export async function sendText(toNumber, body) {
  if (!config.whapi.enabled) return { skipped: true };
  if (!config.whapi.token) {
    logger.warn('whapi enabled but WHAPI_TOKEN missing — skipping send');
    return { skipped: true };
  }
  const to = String(toNumber || '').replace(/[^\d]/g, ''); // WHAPI wants digits only (countrycode+number)
  if (to.length < 10) {
    logger.warn('whapi: recipient number looks invalid — skipping');
    return { skipped: true };
  }
  const url = `${config.whapi.baseUrl.replace(/\/$/, '')}/messages/text`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.whapi.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ to, body }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) { await sleep(500); continue; }
      }
      if (!res.ok) {
        const t = await res.text();
        logger.warn({ status: res.status, body: t.slice(0, 200) }, 'whapi send failed');
        return { error: true, status: res.status };
      }
      logger.info('whapi message sent');
      return { ok: true };
    } catch (err) {
      clearTimeout(timer);
      logger.warn({ err: err?.message, attempt }, 'whapi send error');
      if (attempt < 2) { await sleep(300); continue; }
      return { error: true };
    }
  }
  return { error: true };
}
