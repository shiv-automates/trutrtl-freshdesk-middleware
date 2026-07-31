// Phone-number normalisation for Indian numbers.
// Freshdesk stores numbers inconsistently (in `mobile` usually, sometimes `phone`,
// with or without +91, spaces, dashes), so we generate several variants and search them all.

/** Strip everything except digits and a leading +. */
export function clean(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const plus = s.startsWith('+') ? '+' : '';
  return plus + s.replace(/[^\d]/g, '');
}

/** Return the bare 10-digit subscriber number if we can find one, else ''. */
export function tenDigit(raw) {
  const digits = clean(raw).replace(/^\+/, '');
  if (digits.length >= 10) return digits.slice(-10);
  return '';
}

/**
 * Distinct search variants for a number, most-specific first:
 *   ["9876543210", "+919876543210", "919876543210"]
 * Used to build the Freshdesk contact search query.
 */
export function variants(raw) {
  const ten = tenDigit(raw);
  const out = new Set();
  if (ten) {
    out.add(ten);
    out.add('+91' + ten);
    out.add('91' + ten);
  }
  const c = clean(raw);
  if (c) out.add(c); // whatever they actually passed, cleaned
  return [...out].filter(Boolean);
}

/** Canonical E.164-ish form for India for storing on a new ticket. */
export function toStorage(raw) {
  const ten = tenDigit(raw);
  return ten ? '+91' + ten : clean(raw);
}

export function isValidIndianMobile(raw) {
  const ten = tenDigit(raw);
  return /^[6-9]\d{9}$/.test(ten);
}

// The dummy numbers an LLM reaches for when it fabricates a phone rather than asking:
// 9876543210 (the classic), sequential runs, and all-same-digit. These are format-valid
// Indian mobiles, so isValidIndianMobile() passes them — but a WRITE route must never file a
// ticket against one, because it is never a real caller. (2026-07-29: a warranty call fired
// register_warranty with 9876543210 BEFORE asking the caller anything, creating a junk
// second ticket. Blocking the number here means a fabricated tool call can create nothing.)
const KNOWN_PLACEHOLDER_NUMBERS = new Set([
  '9876543210', '1234567890', '0123456789', '0987654321', '9123456789',
]);

/** True when the 10-digit number is an obvious placeholder/fabrication, not a real caller. */
export function isPlaceholderNumber(raw) {
  const ten = tenDigit(raw);
  if (!ten) return false;
  if (/^(\d)\1{9}$/.test(ten)) return true; // all identical digits (0000000000 … 9999999999)
  return KNOWN_PLACEHOLDER_NUMBERS.has(ten);
}
