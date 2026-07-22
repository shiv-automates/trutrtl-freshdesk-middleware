// Map free-text platform to the EXACT `cf_purchased_from` dropdown choice on
// digicart.freshdesk.com. Unknown → null (left unset; raw text kept in description).
//
// ⚠ NULL MEANS NULL. ticket-fields.js must never paper over it. It used to do
// `mapPlatform(o.platform) || 'Website'` (§9.1 #8) — verified live: platform='Meesho'
// filed as cf_purchased_from='Website'. Platform is the field that decides which return
// policy applies and which invoice we ask for, so a silent default to Website pushed a
// marketplace customer into truTRTL's own 7-day return flow and asked them for the wrong
// invoice. requiredCustomFields() now throws instead; this file's job is simply to never
// invent a value.
//
// ⭐ 2026-07-22 — C6 (client reversal). Meesho and Jabong had briefly been made filable on
// 2026-07-20 (the F-5 dropdown addition). The client has now confirmed truTRTL is **not
// active** on either channel, reversing that. So both are removed from the dropdown list and
// restored to UNMAPPED_CHANNELS: a legacy buyer who names one is **honestly declined and
// called back** (terminal `unmapped_channel`), never silently misfiled as 'Website', and
// they are kept out of the register `platform` enum so Tara can't offer them. See
// REQUEST_freshdesk-admin-meesho-jabong.md (desk admin removes the two dropdown values) and
// TRUTRTL_32_ISSUES_DIAGNOSIS.md §C6.

// The live dropdown, verbatim and complete. THERE IS NO "Other" OPTION — an unmapped
// platform has no correct value here, so it cannot be filed at all.
//
// ⭐ 2026-07-22 — TEN VALUES. Meesho and Jabong are deliberately absent (C6 reversal, above).
// Keep this list byte-for-byte in the admin's order for the values that remain.
export const PLATFORM_CHOICES = [
  'Amazon', 'Flipkart', 'Website', 'Zepto', 'Blinkit',
  'Myntra', 'CRED', 'JioMart', 'BigBasket', 'Swiggy',
];

const ALIASES = [
  [/\bamazon\b/i, 'Amazon'],
  [/\bflipkart\b/i, 'Flipkart'],
  [/\b(website|trutrtl|shopify|own\s*site|official\s*site)\b/i, 'Website'],
  [/\bzepto\b/i, 'Zepto'],
  [/\bblinkit\b/i, 'Blinkit'],
  [/\bmyntra\b/i, 'Myntra'],
  [/\bcred\b/i, 'CRED'],
  [/\b(jio\s*mart|jiomart)\b/i, 'JioMart'],
  [/\b(big\s*basket|bigbasket)\b/i, 'BigBasket'],
  [/\b(swiggy|instamart)\b/i, 'Swiggy'],
];

// Real truTRTL-adjacent channels that have NO value on cf_purchased_from — recognised
// precisely so the route can decline HONESTLY (terminal: callback, no ticket) instead of
// dragging them to the nearest legal-looking value, which on this dropdown is always
// 'Website' (§9.1 #8: wrong return policy, wrong invoice requested).
//
// ⭐ C6 (2026-07-22 client reversal). Meesho and Jabong are back here. They had been emptied
// on 2026-07-20 when the desk briefly added them as dropdown values (F-5); the client has now
// confirmed truTRTL is not active on either, so filing a Meesho/Jabong order is not honest.
// Recognising them (rather than letting them fall through as an unrecognised `unmapped_platform`)
// is what lets a LEGACY buyer who really did purchase there be declined terminally and called
// back, instead of Tara re-asking "where did you buy it?" in a loop she can never satisfy.
//
// ⛔ Whatever is in here must still never map to 'Website', and never ask for an 'Other'
// value: cf_purchased_from decides which return policy applies and which invoice we request,
// so an 'Other' bucket would destroy that signal for every brand on this shared desk.
const UNMAPPED_CHANNELS = [
  /\bmeesho\b/i,
  /\bjabong\b/i,
];

/** True if the text names a channel the middleware recognises but has no cf_purchased_from value for. */
export function isUnmappedChannel(text) {
  return !!text && UNMAPPED_CHANNELS.some((re) => re.test(String(text)));
}

export function mapPlatform(text) {
  if (!text) return null;
  const t = String(text).trim();
  const exact = PLATFORM_CHOICES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  // Unmapped channels FIRST, exactly as ELLE's fork does for offline retail: naming a
  // channel we cannot file is a harder fact than any keyword that follows it, so
  // "bought it on the Meesho website" must resolve to null (→ terminal unmapped_channel),
  // never be dragged to 'Website' by the later /website/ alias — that is the §9.1 #8 defect
  // this ordering exists to prevent. Naming the channel always beats a keyword that follows it.
  if (isUnmappedChannel(t)) return null;
  for (const [re, choice] of ALIASES) if (re.test(t)) return choice;
  return null;
}
