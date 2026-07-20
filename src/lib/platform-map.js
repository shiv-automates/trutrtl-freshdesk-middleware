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
// ⭐ 2026-07-20. Meesho and Jabong now HAVE dropdown values, so the honest answer for them
// changed: they file, as themselves. Never inventing a value and never refusing a value the
// CRM does have are the same rule — the ticket must say where the customer actually bought
// it, and 'Meesho' is now sayable in that field.

// The live dropdown, verbatim and complete. THERE IS NO "Other" OPTION — an unmapped
// platform has no correct value here, so it cannot be filed at all.
//
// ⭐ 2026-07-20 — TWELVE VALUES. The desk admin added 'Meesho' and 'Jabong' to
// cf_purchased_from on 2026-07-20, which retires the whole unmapped-channel story below:
// both file cleanly now, and refusing them would be the new defect. Read back from the
// live field; keep this list byte-for-byte in the admin's order.
export const PLATFORM_CHOICES = [
  'Amazon', 'Flipkart', 'Website', 'Zepto', 'Blinkit',
  'Myntra', 'CRED', 'JioMart', 'BigBasket', 'Swiggy',
  'Meesho', 'Jabong',
];

const ALIASES = [
  [/\bamazon\b/i, 'Amazon'],
  [/\bflipkart\b/i, 'Flipkart'],
  // ⚠ Meesho and Jabong sit ABOVE the /website/ alias, and must stay there. "bought it on
  // the Meesho website" names a marketplace and then says the word "website"; if the
  // Website rule reached it first we would file a Meesho order as a truTRTL.com one — the
  // §9.1 #8 defect this file exists to prevent, now with a legal value available to file
  // instead. Naming the channel always beats a keyword that follows it.
  [/\bmeesho\b/i, 'Meesho'],
  [/\bjabong\b/i, 'Jabong'],
  [/\b(website|trutrtl|shopify|own\s*site|official\s*site)\b/i, 'Website'],
  [/\bzepto\b/i, 'Zepto'],
  [/\bblinkit\b/i, 'Blinkit'],
  [/\bmyntra\b/i, 'Myntra'],
  [/\bcred\b/i, 'CRED'],
  [/\b(jio\s*mart|jiomart)\b/i, 'JioMart'],
  [/\b(big\s*basket|bigbasket)\b/i, 'BigBasket'],
  [/\b(swiggy|instamart)\b/i, 'Swiggy'],
];

// Real truTRTL channels that have NO value on cf_purchased_from — recognised precisely so
// the route can decline HONESTLY (terminal: callback, no ticket) instead of dragging them
// to the nearest legal-looking value, which on this dropdown is always 'Website' (§9.1 #8:
// wrong return policy, wrong invoice requested).
//
// ⭐⭐ EMPTY SINCE 2026-07-20 — and that is the whole point of the change. Meesho and Jabong
// were the only two entries, on the grounds that neither existed in the dropdown. The desk
// admin added BOTH on 2026-07-20, so they are now ordinary aliases above and file exactly
// like Amazon or Zepto. Keeping them here after that would have refused a complaint the CRM
// can accept — the same defect as filing them as 'Website', just pointing the other way,
// and it would have cost a 2024–25 Meesho buyer still inside warranty their ticket.
//
// ⚠ THE MECHANISM STAYS, deliberately, even with nothing in it. It is the only path that
// distinguishes "we know exactly where you bought it and Freshdesk has nowhere to put that"
// (terminal — asking again cannot help) from "we didn't understand you" (recoverable — ask
// again). The next channel truTRTL sells on before the admin adds it lands here, and the
// route, its reason code and its spoken line are all still wired. Deleting the seam would
// mean re-deriving it under time pressure with a live caller on the line.
//
// ⛔ Whatever goes in here must still never map to 'Website', and never ask for an 'Other'
// value: cf_purchased_from decides which return policy applies and which invoice we request,
// so an 'Other' bucket would destroy that signal for every brand on this shared desk.
const UNMAPPED_CHANNELS = [];

/** True if the text names a real truTRTL channel that has no cf_purchased_from value. */
export function isUnmappedChannel(text) {
  return !!text && UNMAPPED_CHANNELS.some((re) => re.test(String(text)));
}

export function mapPlatform(text) {
  if (!text) return null;
  const t = String(text).trim();
  const exact = PLATFORM_CHOICES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  // Unmapped channels FIRST, exactly as ELLE's fork does for offline retail: naming a
  // channel we cannot file is a harder fact than any keyword that follows it, so "bought it
  // at the Croma store near the mall" must never be dragged to a value by a later alias.
  // (The list is empty as of 2026-07-20 — Meesho and Jabong graduated to real values and
  // are now ordinary aliases, placed above /website/ for exactly this reason.)
  if (isUnmappedChannel(t)) return null;
  for (const [re, choice] of ALIASES) if (re.test(t)) return choice;
  return null;
}
