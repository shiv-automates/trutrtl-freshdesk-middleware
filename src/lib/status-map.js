// Freshdesk ticket status int → plain words Tara can say, plus a safe generic
// "next step" line so we never have to read internal notes aloud.

const LABELS = {
  2: 'registered and open',
  3: 'in progress',
  4: 'resolved',
  5: 'completed and closed',
};

const NEXT_STEPS = {
  2: 'Our service team will schedule a technician visit, usually within 2 to 3 working days.',
  3: 'The service team is working on it; you should hear about a technician visit shortly.',
  4: 'It has been marked resolved — please let us know if the issue comes back.',
  5: 'This complaint is completed and closed.',
};

export function statusLabel(code) {
  return LABELS[Number(code)] || 'being processed';
}

export function nextStep(code) {
  return NEXT_STEPS[Number(code)] || 'Our team will update you shortly.';
}

export function isClosed(code) {
  return Number(code) === 5;
}

export const STATUS_LABELS = LABELS; // exported for tests

// ── ⭐ M-4 / M-5: the QUEUE vocabulary ────────────────────────────────────────
//
// The status integer alone is not the outcome. On this desk the real outcome lives in
// the QUEUE (the Freshdesk group, mirrored on the cf_group_custom dropdown), which the
// middleware never read — so a ticket closed because a replacement was couriered spoke
// IDENTICALLY to one closed because the customer stopped replying (defects 5 and 8).
//
// The meanings below are the CLIENT'S OWN, from columns F/G of
// "truTRTL AI Call center issue" — we were never given this glossary before. Nothing
// here is inferred: a queue whose meaning the client did not supply (Warranty, with
// Factory) gets a canonical key but NO spoken phrase, and a queue we do not recognise
// at all (e.g. another brand's MILTON HV / BAD REVIEWS) gets neither. Silence is the
// honest answer on a recorded line; guessing is not.

/** Normalise a queue string for lookup: case, punctuation and spacing all vary in the wild. */
const normQueue = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// cf_group_custom / group-name text → canonical key. Aliases are deliberate: ops type
// the same queue several ways ('No Tech Found', 'No Technician Found'), and the create
// path writes 'WITH DIGICART' while the group itself reads 'with digiCART'.
const QUEUE_ALIASES = {
  'with digicart': 'with_digicart',
  digicart: 'with_digicart',
  'rapid era': 'rapid_era',
  'with rapid era': 'rapid_era',
  'with 247': 'with_247',
  247: 'with_247',
  'with technicians': 'with_technicians',
  'with technician': 'with_technicians',
  'no technician found': 'no_technician_found',
  'no tech found': 'no_technician_found',
  courier: 'courier',
  'with courier': 'courier',
  'no comm from customer': 'no_comm_customer',
  'no comm cust': 'no_comm_customer',
  'no communication from customer': 'no_comm_customer',
  'with customer': 'with_customer',
  warranty: 'warranty',
  'with factory': 'with_factory',
};

// group_id → canonical key, for the tickets where cf_group_custom is empty (it is a
// MIRROR dropdown, and ops re-queue by moving the group without always re-picking it).
// Only the three ids verified live on the account are here — see
// FRESHDESK_ACCOUNT_NOTES.md §"How work flows (the queues / Groups)".
const GROUP_ID_QUEUE = {
  81000089580: 'with_digicart',
  81000089582: 'with_247',
  81000089594: 'warranty',
};

/**
 * What Tara may say about the queue — the client's F/G meanings, in customer words.
 * Present tense: this is where the case IS. (For a CLOSED case the outcome sentence
 * comes from closureReason() instead.)
 */
export const GROUP_SPEECH = {
  with_digicart: 'your complaint has come in and our service desk is picking it up',
  rapid_era: 'it has been assigned to one of our service centres',
  with_247: 'it has been assigned to one of our service centres',
  with_technicians: 'it is with a technician now',
  no_technician_found: 'we have not been able to arrange a technician in your area yet',
  // ⭐ C3 (2026-07-22, defect #14): the courier queue covers ANY courier movement — an
  // outbound replacement, but ALSO an inbound refund/return pickup. Hardcoding "a
  // replacement has been dispatched" told a REFUND customer (Adarsh Jain, 12010) the wrong
  // thing. We have no field that distinguishes replacement/refund/repair (client Open
  // Question 3), so we state only what is TRUE for the whole queue and offer the exact
  // outcome via a person, rather than assert a specific one.
  courier: 'it is with the courier team now — let me get you the exact courier update from someone who can see the full detail',
  no_comm_customer: 'we have been trying to reach you and have not had a reply yet',
  with_customer: 'it is open with you at the moment while the team sorts it out with you directly',
  // warranty / with_factory: the client's glossary does not define these. No phrase —
  // Tara falls back to the status label rather than inventing a meaning.
};

/**
 * Resolve a ticket's queue from cf_group_custom, falling back to group_id.
 * @returns {{raw: string|null, key: string|null, spoken: string|null}}
 *   `raw` is ops vocabulary for the log line, `spoken` is the only sayable form.
 */
export function resolveQueue(rawGroupCustom, groupId) {
  const raw = String(rawGroupCustom ?? '').trim() || null;
  const key = QUEUE_ALIASES[normQueue(raw)]
    || GROUP_ID_QUEUE[String(groupId ?? '')]
    || null;
  return { raw, key, spoken: (key && GROUP_SPEECH[key]) || null };
}

// ── ⭐ M-5: why a complaint was closed (defect 8) ─────────────────────────────
//
// "She couldn't explain the reason why the complaint is closed." Two layers caused it:
// nextStep(5) is a fixed sentence, AND the answer lives in notes that safeLatestNote()
// correctly refuses to read aloud ("Product started working. Hence closed",
// "It's Started now 19:05"). ⛔ safeLatestNote() is NOT loosened to fix this — reading
// internal shorthand onto a recorded line is a worse defect than the one it solves.
//
// Instead we NORMALISE. The queue at closure is the client's own outcome vocabulary, so
// it answers first; only if it cannot do we look at the note text — and then purely as a
// CLASSIFIER. The raw note is never returned, never quoted, never paraphrased.

const CLOSURE_BY_QUEUE = {
  // ⭐ C3: NOT "a replacement was dispatched" — a courier-closed case may be a refund or a
  // return, not a replacement (defect #14). State the true, generic fact and route the
  // specific outcome to a person. The precise disposition needs a Freshdesk field we don't
  // have yet (client Open Question 3); until then we never assert replacement-vs-refund.
  courier: 'it was closed after a courier movement — a colleague can confirm exactly what was sent or collected',
  no_comm_customer: "we closed it after we couldn't reach you for about fifteen days",
  no_technician_found: "we couldn't arrange a technician in your area",
};

// Deliberately TINY. Every pattern here must be one whose presence in a note cannot
// mean the opposite ("started working" does not appear in a note about a product that
// never started). Tempting additions like /refund/ or /replacement/ are left out on
// purpose: "customer asking for refund, denied" would otherwise become "a refund was
// processed" — a fabricated outcome spoken to the customer it was denied to.
const NOTE_NORMALISERS = [
  [/\b(started\s+working|start\s+working|working\s+now|resolved)\b/i,
    'the product was reported working again'],
];

/**
 * A normalised, sayable closure sentence — or null when we genuinely cannot tell.
 * Runs ONLY on status 4 (resolved) and 5 (closed).
 *
 * @param {number|string} code   Freshdesk status int
 * @param {{queue?: string|null, noteText?: string}} [ctx]
 *   `queue` is a canonical key from resolveQueue(); `noteText` is the raw latest note,
 *   used ONLY to match a pattern. Null means "say the status, then offer a callback" —
 *   which is honest. Inventing a reason is not.
 */
export function closureReason(code, ctx = {}) {
  const status = Number(code);
  if (status !== 4 && status !== 5) return null;
  const byQueue = CLOSURE_BY_QUEUE[ctx.queue];
  if (byQueue) return byQueue;
  const text = String(ctx.noteText ?? '');
  if (text) {
    for (const [re, phrase] of NOTE_NORMALISERS) {
      if (re.test(text)) return phrase;
    }
  }
  return null;
}

// ── ⭐ M-4: SLA aging (defect 20) ─────────────────────────────────────────────
//
// "Jo 1 month se complaint chal rahi hai — ticket ma kya chal raha hai." There was no
// aging logic anywhere: nothing compared days_since_registered against the documented
// SLA, so a 32-day-old breached case spoke EXACTLY like a 2-day-old one, reassurance
// boilerplate and all. NEXT_STEPS[2] promises "2 to 3 working days" — quoting that back
// to someone who has waited a month is the insult inside the defect.

/** Documented SLA: a technician visit is promised in 2–3 working days; 7 days is generous. */
export const SLA_OPEN_DAYS = 7;

/** Replaces the reassurance line once the SLA is blown. Acknowledge once, then act. */
export const SLA_BREACH_NEXT_STEP =
  'This has taken longer than it should have. I can put you through to a colleague now, '
  + 'or log a callback so a senior team member takes this up today.';

/** True when an OPEN/PENDING complaint has outlived the SLA. Closed cases never breach. */
export function isSlaBreached(code, days) {
  const status = Number(code);
  const n = Number(days);
  if (status !== 2 && status !== 3) return false;
  return Number.isFinite(n) && n > SLA_OPEN_DAYS;
}

// ── Service partner → a sentence a customer can actually hear ────────────────
//
// cf_given_to_service_partner's live values are 'No', 'Rapid Era', 'On SIte Go'
// (the typo is real, verified on the desk) and 'Others'. Handing those to the voice
// agent has the same failure mode the raw queue name did: 'Others' means nothing to a
// caller, 'On SIte Go' is misspelled, and a partner is a third party the customer never
// contracted with — truTRTL owns the promise either way. So we resolve to a spoken
// phrase HERE, in code, rather than trusting the prompt not to read the dropdown out.
const PARTNER_SPEECH = {
  'rapid era': 'with our authorised service partner',
  'on site go': 'with our authorised service partner',
  others: 'with our service team',
};

/**
 * A customer-safe phrase for cf_given_to_service_partner.
 * 'No' (not sent to a partner) should be filtered by the caller and never reaches here.
 * An unrecognised partner degrades to the generic phrase — never to the raw string.
 */
export function servicePartnerSpoken(raw) {
  const key = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key || key === 'no') return null;
  return PARTNER_SPEECH[key] || 'with our authorised service partner';
}
