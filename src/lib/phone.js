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
