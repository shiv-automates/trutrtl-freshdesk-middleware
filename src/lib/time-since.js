// "Days since registered", computed in a target timezone (default Asia/Kolkata)
// so "4 days ago" matches the customer's local sense of time.

/** Return YYYY-MM-DD for an instant, as seen in `timeZone`. */
function localDateParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  // en-CA renders as YYYY-MM-DD
  const [y, m, d] = fmt.format(date).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Whole calendar days between `createdAtISO` and `now`, in `timeZone`.
 * Same calendar day = 0, next day = 1. Returns null if the date is unparseable.
 */
export function daysSince(createdAtISO, timeZone = 'Asia/Kolkata', now = new Date()) {
  if (!createdAtISO) return null;
  const created = new Date(createdAtISO);
  if (Number.isNaN(created.getTime())) return null;
  const a = localDateParts(created, timeZone);
  const b = localDateParts(now, timeZone);
  const diff = Math.round((b - a) / 86400000);
  return diff < 0 ? 0 : diff;
}

/** Human phrase: 0→"today", 1→"yesterday", n→"n days ago". */
export function daysSincePhrase(days) {
  if (days == null) return 'recently';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * ⭐ M-4 (defect 17): the registration DATE, spoken — "18 June 2026", rendered in
 * `timeZone` so it matches the customer's calendar, not the server's.
 *
 * "Complaint registered date nahi bata pati hai." formatStatus() handed Tara the integer
 * days_since_registered and nothing else time-related, so answering "when did I register
 * this?" meant doing calendar arithmetic mid-call from "32" — which she cannot reliably
 * do and must never be asked to. We hand her the finished date instead.
 *
 * Returns null on a missing/unparseable timestamp (never a guessed date).
 */
export function formatDateSpoken(iso, timeZone = 'Asia/Kolkata') {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-GB renders "18 June 2026" — day first, month in words, no ordinal suffix for TTS.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
}
