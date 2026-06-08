// Freshdesk REST API v2 client for digicart.freshdesk.com.
// - Basic auth: base64("<API_KEY>:X")
// - Hard timeout per call (default 5s) via AbortController
// - One retry on 429 (honouring Retry-After, capped) and on 5xx
// - Frugal by design: the account allows only ~40 req/min, shared with other automation.
import { config } from './config.js';
import { logger } from './logger.js';
import { variants } from './phone.js';

const BASE = `https://${config.freshdeskDomain}/api/v2`;
const AUTH = 'Basic ' + Buffer.from(`${config.freshdeskApiKey}:X`).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Low-level request with timeout + single retry on 429/5xx.
 * Returns { ok, status, data, headers, retryAfter }. Throws only on network/timeout
 * AFTER exhausting the retry budget (callers wrap this and degrade gracefully).
 */
async function request(method, path, { query, body } = {}) {
  let url = `${BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const maxAttempts = 1 + Math.max(0, config.freshdeskMaxRetries);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.freshdeskTimeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: AUTH,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining != null && Number(remaining) <= 3) {
        logger.warn({ remaining }, 'freshdesk rate-limit budget low');
      }

      // Retryable?
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after')) || 1;
        const waitMs = Math.min(retryAfter * 1000, 2000);
        logger.warn({ status: res.status, attempt, waitMs }, 'freshdesk retrying');
        await sleep(waitMs);
        continue;
      }

      let data = null;
      const text = await res.text();
      if (text) {
        try { data = JSON.parse(text); } catch { data = null; }
      }
      return {
        ok: res.ok,
        status: res.status,
        data,
        retryAfter: Number(res.headers.get('retry-after')) || null,
      };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const aborted = err?.name === 'AbortError';
      logger.warn({ attempt, aborted, err: err?.message }, 'freshdesk request error');
      if (attempt < maxAttempts) {
        await sleep(200);
        continue;
      }
    }
  }
  throw lastErr || new Error('freshdesk request failed');
}

/** GET a ticket by id with the includes we need for a status read. */
export async function getTicket(id, includes = ['conversations', 'requester', 'stats']) {
  const r = await request('GET', `/tickets/${encodeURIComponent(id)}`, {
    query: { include: includes.join(',') },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`getTicket ${id} -> ${r.status}`);
  return r.data;
}

/**
 * Find a contact by phone. Searches both `mobile` and `phone` across number
 * variants (10-digit, +91…, 91…). Returns the first contact or null.
 */
export async function searchContacts(rawPhone) {
  const vs = variants(rawPhone).slice(0, 4);
  if (!vs.length) return null;
  const clauses = [];
  for (const v of vs) {
    clauses.push(`mobile:'${v}'`, `phone:'${v}'`);
  }
  const query = `"${clauses.join(' OR ')}"`; // Freshdesk requires the whole thing quoted
  const r = await request('GET', '/search/contacts', { query: { query } });
  if (!r.ok) {
    logger.warn({ status: r.status }, 'searchContacts failed');
    return null;
  }
  const results = r.data?.results || [];
  return results[0] || null;
}

/** List a requester's tickets, newest first, with stats. */
export async function getTicketsByRequester(requesterId) {
  const r = await request('GET', '/tickets', {
    query: {
      requester_id: String(requesterId),
      order_by: 'created_at',
      order_type: 'desc',
      include: 'stats',
    },
  });
  if (!r.ok) throw new Error(`getTicketsByRequester ${requesterId} -> ${r.status}`);
  return r.data || [];
}

/** Custom-field ticket search (only used if COMPLAINT_ID_MODE=CUSTOM_FIELD). */
export async function searchTicketsByCustomField(field, value) {
  const query = `"${field}:'${value}'"`;
  const r = await request('GET', '/search/tickets', { query: { query } });
  if (!r.ok) {
    logger.warn({ status: r.status, field }, 'searchTicketsByCustomField failed');
    return [];
  }
  return r.data?.results || [];
}

/** Create a ticket. Returns the created ticket (incl. id) or throws. */
export async function createTicket(payload) {
  const r = await request('POST', '/tickets', { body: payload });
  if (!r.ok) {
    logger.error({ status: r.status, errors: r.data?.errors }, 'createTicket failed');
    throw new Error(`createTicket -> ${r.status}`);
  }
  return r.data;
}

/** Update a ticket (used by TEST_AUTO_CLOSE to immediately close test tickets). */
export async function updateTicket(id, payload) {
  const r = await request('PUT', `/tickets/${encodeURIComponent(id)}`, { body: payload });
  if (!r.ok) throw new Error(`updateTicket ${id} -> ${r.status}`);
  return r.data;
}

/** Add a note to a ticket (private by default). */
export async function addNote(ticketId, body, isPrivate = true) {
  const r = await request('POST', `/tickets/${encodeURIComponent(ticketId)}/notes`, {
    body: { body, private: isPrivate },
  });
  if (!r.ok) throw new Error(`addNote ${ticketId} -> ${r.status}`);
  return r.data;
}

export const _internals = { BASE, request };
