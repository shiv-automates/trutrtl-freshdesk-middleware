// Helpers for talking to the Ravan/Agni voice agent (Tara — truTRTL):
//  - defensive parsing of request bodies (Ravan's exact contract is undocumented,
//    so accept both flat params and a wrapped {args}/{parameters} envelope)
//  - the BRAND FILTER and the IDENTITY GATE (the two guardrails this line never had)
//  - the "safe note" rule for what Tara may read aloud
//  - voice-friendly response formatting
//  - lenient parsing of the after-call webhook payload
import { config } from './config.js';
import { stripHtml, toOneSentence } from './html-strip.js';
import {
  statusLabel, nextStep, resolveQueue, closureReason, isSlaBreached, SLA_BREACH_NEXT_STEP,
  servicePartnerSpoken,
} from './status-map.js';
import { daysSince, daysSincePhrase, formatDateSpoken } from './time-since.js';

/** Unwrap {args}/{parameters} envelopes; otherwise return the body as-is. */
export function unwrapParams(body) {
  if (body && typeof body === 'object') {
    if (body.args && typeof body.args === 'object') return body.args;
    if (body.parameters && typeof body.parameters === 'object') return body.parameters;
  }
  return body || {};
}

// ── ⭐ The brand filter ───────────────────────────────────────────────────────

/**
 * digicart.freshdesk.com is ONE helpdesk shared by FOUR brands (MILTON, APARNA,
 * FKSB, truTRTL) over ONE ticket-id sequence (~12k tickets, ~5 digits). A truTRTL
 * caller reading out any 5-digit number therefore resolves *some* brand's ticket —
 * and we performed no brand check at all, so another brand's customer's status +
 * product + latest update landed in the LLM's context with only prompt discipline
 * between it and disclosure (dossier §9.1 🔴 #1).
 *
 * Every ticket we read must be PROVED ours before one field of it is formatted.
 * Strict equality against config.cf.brandValue ('truTRTL' — byte-for-byte, it is
 * the literal option string on cf_brand121540). A mismatch, a missing field, or an
 * unexpected shape all fail CLOSED — the safe direction.
 */
export function isBrandTicket(ticket) {
  if (!ticket) return false;
  const cf = ticket.custom_fields || {};
  return cf[config.cf.brand] === config.cf.brandValue;
}

// ── ⭐ The identity gate ──────────────────────────────────────────────────────

// Honorifics/suffixes a caller may add to either side of the comparison.
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'madam', 'maam',
  'shri', 'sri', 'smt', 'ji',
]);

/**
 * Normalise a name to comparable tokens: accents stripped, lowercased,
 * punctuation dropped ("Mr. K. Sharma" → ['k','sharma']), honorifics removed.
 */
export function nameTokens(raw) {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !HONORIFICS.has(t));
}

// ── C1 (2026-07-22): Unicode-aware tokens + fuzzy matching ───────────────────
//
// nameTokens() now keeps letters of ANY script plus their combining marks (\p{L}\p{M}\p{N}),
// so a Devanagari name such as `वसीम` produces a real token instead of being erased to spaces.
// The old `[^a-z0-9\s]` kept only ASCII, so `nameTokens('वसीम')` returned `[]` and the gate
// failed even `वसीम` vs `वसीम` — a 100% false-negative on every Hindi-script name (diagnosis
// §C1, defect 10). `\p{M}` keeps combining vowel signs (matras) attached to their letter.
//
// The registration call and the status call are two separate ASR passes, so the SAME spoken
// name is often transliterated slightly differently each time ("grus" vs "gruz", "DR grus" →
// the single garbled token 'grus'). Byte-exact subset matching turned every such drift into a
// refused-own-complaint (diagnosis §C1, defect 1). We add a small confidence tier — a phonetic
// key plus a length-bounded edit distance — so ASR variants pass while genuinely different
// names ('verma' vs 'sharma', 'priyanka' vs 'priya') still fail. Loosening here is safe because
// cross-brand / cross-customer disclosure is closed by isBrandTicket(), enforced independently
// before formatStatus() ever runs.

/** Classic Soundex — `grus` and `gruz` both key to G620; `verma`(V650) ≠ `sharma`(S650). */
function soundex(str) {
  const s = String(str).toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  const code = {
    b: 1, f: 1, p: 1, v: 1,
    c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
    d: 3, t: 3, l: 4, m: 5, n: 5, r: 6,
  };
  let out = s[0].toUpperCase();
  let prev = code[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = code[s[i]] || 0;
    if (c !== 0 && c !== prev) out += c;
    // h and w are transparent (do not reset the adjacency "previous code"); vowels reset it.
    if (s[i] !== 'h' && s[i] !== 'w') prev = c;
  }
  return (out + '000').slice(0, 4);
}

/** Levenshtein edit distance (two-row, O(n) space). */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Two name tokens are "the same person's token" when they are equal, share a phonetic key
 * (Latin only — Soundex is undefined for other scripts), or are within a tight, length-scaled
 * edit distance (≤1 for short tokens, ≤2 for longer). The ceiling is deliberately small:
 * `grus`/`gruz` (d=1) pass; `priyanka`/`priya` (d=3) and `verma`/`sharma` do not.
 */
function tokensSimilar(x, y) {
  if (x === y) return true;
  const bothLatin = /^[a-z]+$/.test(x) && /^[a-z]+$/.test(y);
  if (bothLatin && soundex(x) === soundex(y)) return true;
  const maxDist = Math.min(x.length, y.length) <= 4 ? 1 : 2;
  return levenshtein(x, y) <= maxDist;
}

/**
 * Forgiving name comparison for the identity gate.
 *
 * Passes when either token set is a subset of the other, so:
 *   "Priya"        vs "Priya Sharma"  → true   (first name only — a real caller)
 *   "priya sharma" vs "Sharma Priya"  → true   (order-insensitive)
 *   "Mrs. Priya"   vs "priya sharma"  → true   (honorific stripped)
 * Fails when a token contradicts the record:
 *   "Priya Verma"  vs "Priya Sharma"  → false  (a different person)
 *   "Priyanka"     vs "Priya"         → false  (no prefix matching — prefix
 *                                               matching would let "P" match anyone)
 * Empty on either side → false. The gate fails closed by construction.
 */
export function namesMatch(stated, actual) {
  const a = nameTokens(stated);
  const b = nameTokens(actual);
  if (!a.length || !b.length) return false;
  // ⭐ C1: subset matching is now fuzzy per-token (tokensSimilar) rather than byte-exact, so
  // an ASR-drifted 'grus'/'gruz' passes while 'verma'/'sharma' still fails. Still a subset in
  // BOTH directions so the shorter side (first name only, partial record) continues to match,
  // and empty-on-either-side still fails closed above.
  const subset = (xs, ys) => xs.every((t) => ys.some((u) => tokensSimilar(t, u)));
  return subset(a, b) || subset(b, a);
}

/** The requester name on a ticket fetched with include=requester. Never returned to Tara. */
function requesterName(ticket) {
  const r = ticket?.requester || {};
  const composed = [r.first_name, r.last_name].filter(Boolean).join(' ');
  return r.name || composed || ticket?.contact?.name || '';
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
 * ⛔ CLASSIFIER INPUT ONLY — never a spoken value, which is why it is not exported.
 *
 * The newest note text of ANY kind, including the internal shorthand safeLatestNote()
 * deliberately refuses ("It's Started now 19:05"). closureReason() pattern-matches on
 * this to pick a NORMALISED sentence; the text itself never reaches the response, so
 * the "safe note" rule above stays exactly as strict as it was (M-5, defect 8).
 */
function latestNoteText(conversations) {
  if (!Array.isArray(conversations) || !conversations.length) return '';
  const sorted = [...conversations].sort(
    (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
  );
  for (const c of sorted) {
    const text = stripHtml(c.body_text || c.body || '');
    if (text) return text;
  }
  return '';
}

/**
 * Build the voice-ready status response from a Freshdesk ticket.
 *
 * ⚠ CALLERS MUST HAVE ALREADY PASSED THE TICKET THROUGH isBrandTicket().
 *
 * The identity gate is enforced HERE, server-side, because a guardrail that lives
 * only in the prompt is a guardrail the model can talk itself out of. The prompt
 * says "match what they say to the record yourself" while formatStatus() returned
 * no name at all — the rule it leans on hardest was unimplementable, so Tara would
 * either skip the gate or hallucinate a match (dossier §9.1 🔴 #1).
 *
 *  - `opts.callerStatedName` is compared to the ticket's requester here.
 *  - We return ONLY the boolean `name_matches`. The real name is NEVER returned:
 *    if it were in the response it would be in the LLM's context, and a name in
 *    context is a name that can be read out — which hands an impostor the answer.
 *  - No stated name (or no match) ⇒ `product` and `latest_update` are withheld.
 *    Tara may confirm a complaint EXISTS; she may not describe it.
 *
 * @param {object|null} ticket
 * @param {{callerStatedName?: string}} [opts]
 */
export function formatStatus(ticket, opts = {}) {
  if (!ticket) return notFound();
  const status = Number(ticket.status);
  const nameMatches = namesMatch(opts.callerStatedName, requesterName(ticket));

  // ⭐ C1 (2026-07-22): the gate is now PATH-DEPENDENT. On a by-PHONE lookup the caller has
  // already proven possession of the registered mobile AND isBrandTicket() has independently
  // proven the ticket is truTRTL's, so phone + brand IS the identity — the route passes
  // `phoneVerified:true` and the case detail is returned regardless of the name. `name_matches`
  // is still computed and returned as a SOFT signal. On the by-ID path (no phoneVerified) the
  // name check remains a HARD gate — a guessed 5-digit number could otherwise land on another
  // same-brand customer's ticket — but it is now fuzzy + Unicode-aware (see namesMatch/C1).
  const identityProven = opts.phoneVerified === true || nameMatches;

  // ⭐ MINIMAL BODY FIRST. Identity not proved → NOTHING case-specific is ever built
  // into `out`, so nothing case-specific can cross the wire. The gate is enforced by
  // construction, not by prompt discipline: status_label, days_since_registered,
  // expected_next_step, product and latest_update are added ONLY after the gate passes.
  // A caller who fails the gate learns that a complaint EXISTS (found:true) and not one
  // describable fact about it.
  // ⭐ C1 FIX-2 (2026-07-23): report the DISCLOSURE DECISION, not the raw name check. The agent
  // keys on `name_matches` to decide whether to speak the case — so on a by-PHONE lookup, where
  // phone+brand IS the identity, `name_matches` must be TRUE or the agent throws away the detail
  // the server deliberately included and refuses the caller their own complaint (real defect:
  // caller "वसीम" whose ticket is stored Latin "Washim" — cross-script, name never matches, but
  // the phone did). On the by-ID path `identityProven === nameMatches`, so this is unchanged and
  // still a hard gate. `name_via` records how identity was proven, for logs/debugging only.
  const out = {
    found: true,
    complaint_number: String(ticket.id),
    name_matches: identityProven,
  };
  if (!identityProven) return out;
  // Past the gate — record how identity was proven (logs/debugging only; not case-specific).
  out.name_via = opts.phoneVerified === true ? 'phone' : 'name';

  // Identity proved → add the case detail.
  out.status_label = statusLabel(status);
  // ⭐ Set ONLY when we actually have it (defect: null-vs-omitted). An unparseable
  // created_at used to emit `days_since_registered: null` into a prompt that tells Tara to
  // read back what she is given — a null in context is a null that can be spoken ("your
  // complaint is null days old"). Every other optional field on this response is simply
  // ABSENT when unknown; this one now behaves the same. registered_phrase already degrades
  // to "recently" on its own, and isSlaBreached() treats a missing count as "not breached",
  // so the silent path stays correct.
  const daysSinceRegistered = daysSince(ticket.created_at, config.timezone);
  if (daysSinceRegistered != null) out.days_since_registered = daysSinceRegistered;
  out.expected_next_step = nextStep(status);
  const cf = ticket.custom_fields || {};
  // Read order is truTRTL's own and stays that way: cf_custom_tags FIRST, the brand
  // tree's cf_product_category only as a fallback. (The ELLE fork flips these for a
  // casing quirk in ITS tag tree — that reason does not hold here. Do not flip it.)
  const product = cf[config.cf.product] || cf[config.cf.productCategory];
  if (product) out.product = product;
  const note = safeLatestNote(ticket.conversations);
  if (note) out.latest_update = note;

  // ── ⭐ M-4 STATUS ENRICHMENT (defects 5, 8, 17, 19, 20) ────────────────────
  // Everything below is INSIDE the gate on purpose. It is the most case-specific
  // material this response has ever carried — the queue, who holds the unit, when it
  // was registered — so it must be unreachable for a caller whose identity we have not
  // proved. If any of it is ever hoisted above `if (!identityProven) return out;`, the
  // gate is broken however green the rest of the suite looks.

  // The queue is where the real outcome lives (client's own F/G glossary).
  //
  // ⛔ THE RAW QUEUE STRING IS NOT ON THE WIRE, AND MUST NOT BE PUT BACK. This response is
  // read by an LLM under a heading that literally says "Tara reads this aloud", so shipping
  // `queue: 'with digiCART'` / 'Rapid Era' / 'No Comm from Customer' put internal ops
  // vocabulary one retrieval-miss away from a customer's ear: the only thing forbidding it
  // was a KB paragraph (§6.2 B), i.e. RAG, and the system prompt does not mention the queue
  // at all. It was justified as "raw, for the log line" — but the log line runs SERVER-SIDE
  // in routes/complaint-status.js, where the whole ticket is already in scope, so nothing
  // needed to be round-tripped through the voice agent's context to get there.
  // `queue_spoken` (the client's own customer-facing phrasing, absent when we have no
  // client-supplied meaning) is the ONLY form that crosses the wire. Same standard as the
  // identity gate: a guardrail enforced by code beats one enforced by prompt discipline.
  const queue = resolveQueue(cf[config.cf.groupCustom], ticket.group_id);
  if (queue.spoken) out.queue_spoken = queue.spoken;

  // Why it closed — normalised, never the raw note (M-5).
  const closure = closureReason(status, {
    queue: queue.key,
    noteText: latestNoteText(ticket.conversations),
  });
  if (closure) out.closure_reason = closure;

  // The registration date, finished. Tara is never handed an integer and asked to do
  // calendar arithmetic on a live call (defect 17).
  const registeredOn = formatDateSpoken(ticket.created_at, config.timezone);
  if (registeredOn) out.registered_on = registeredOn;
  out.registered_phrase = daysSincePhrase(out.days_since_registered);

  // Pickup / dispatch state (defect 19). These are the fields that actually move when a
  // unit is collected, and the middleware read none of them. Still incomplete: no field
  // on this desk holds the reverse-pickup AWB yet — that is F-4, an admin gap, and we
  // say nothing rather than imply we can track a courier.
  const partner = String(cf[config.cf.servicePartner] ?? '').trim();
  // 'No' is the dropdown's explicit "not sent to a partner" value, not a partner name.
  //
  // ⭐ We send a SPOKEN form, never the raw dropdown value — the same rule that keeps the
  // raw queue name off this response. The live values are 'Rapid Era', 'On SIte Go'
  // (a real typo on the desk) and 'Others': internal ops vocabulary that is variously
  // meaningless ("Others"), misspelled, or a third party the caller never contracted with.
  // A guardrail enforced here cannot be talked around by the model, whereas a prompt rule
  // saying "don't read the partner name" can (defect 19).
  if (partner && !/^no$/i.test(partner)) out.service_partner_spoken = servicePartnerSpoken(partner);
  // Not in config.cf yet (another workstream owns config.js) — read the verified live
  // key directly, and prefer the config entry the moment it exists.
  const fieldAgent = cf[config.cf.fieldAgentTicket || 'cf_field_agent_ticket_number'];
  if (fieldAgent) out.field_agent_ticket = String(fieldAgent);

  // SLA aging (defect 20). Past the SLA on an open case, the reassuring boilerplate is
  // replaced outright — a month-old complaint must not be answered with "usually within
  // 2 to 3 working days", which is the sentence that made the client file this defect.
  if (isSlaBreached(status, out.days_since_registered)) {
    out.sla_breached = true;
    out.expected_next_step = SLA_BREACH_NEXT_STEP;
  }
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

  const cust = d.customer || b.customer || {};
  return {
    callId: firstOf(d.call_session_id, d.call_id, d.callId, d.session_id, d.sessionId,
      d.conversation_id, d.conversationId, d.id, b.call_session_id, b.call_id, b.id) || null,
    phone: firstOf(d.phone, d.phone_number, d.caller_number, d.callerNumber, d.from, d.from_number,
      d.fromNumber, d.customer_number, d.customerNumber, d.customer_phone, d.mobile,
      cust.number, cust.phone, cust.phone_number, b.from, b.phone, b.phone_number, b.caller_number) || null,
    callerName: firstOf(d.caller_name, d.callerName, d.customer_name, d.name, cust.name, b.caller_name) || null,
    // product/platform: only ever an EXPLICIT field Ravan sends. We never infer them
    // from the summary or transcript — a guess here becomes a fabricated CRM field on
    // a real ticket (the whole point of dossier §9.1 🔴 #2). Absent ⇒ null ⇒ after-call
    // refuses to create a ticket rather than invent a product.
    product: firstOf(d.product, d.product_name, d.productName, pca.product, b.product) || null,
    platform: firstOf(d.platform, d.purchased_from, d.purchasedFrom, pca.platform, b.platform) || null,
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
