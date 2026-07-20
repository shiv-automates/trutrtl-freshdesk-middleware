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

// The live dropdown, verbatim and complete. THERE IS NO "Other" OPTION — an unmapped
// platform has no correct value here, so it cannot be filed at all.
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

// LEGACY truTRTL channels with NO value on cf_purchased_from. An older channel list
// (Knowledge Base §"Sold on", Master Brief:17) named Meesho and Jabong alongside
// Amazon/Flipkart/Zepto/etc., but neither exists in the account's dropdown — so this is
// not a missing alias we could add, it is a channel with no correct answer anywhere in
// Freshdesk.
//
// ⭐⭐ SETTLED 2026-07-20 — DO NOT "FIX" THIS BY ADDING THEM. Manish gave the current buy
// list in writing: Amazon, Flipkart, Swiggy Instamart, Blinkit, Zepto, JioMart, BigBasket,
// truTRTL.com. MEESHO AND JABONG ARE NOT ON IT. Every one of the eight that IS on it maps
// cleanly to a live dropdown value today (Swiggy Instamart → 'Swiggy', truTRTL.com →
// 'Website'), so the current buy list is 100% filable and needs no change here — asserted
// in test/unit/helpers.test.js so a later edit to ALIASES cannot break it quietly.
// That makes isUnmappedChannel() PERMANENT behaviour rather than a stopgap: these are not
// channels we are waiting on a dropdown value for, they are channels truTRTL does not sell
// on. The original F-5 ("please add Meesho and Jabong") has been withdrawn as written —
// its justification was that they were current sales channels, and that is now false.
//
// ⚠ But the REGEX STAYS, and both still map to null. Two reasons, and neither is admin
// backlog: (1) a 2024–25 Meesho buyer with a ceiling fan is inside a 2-year warranty until
// 2027, so real callers still exist; (2) the alternative to recognising them is not "no
// Meesho callers", it is `mapPlatform('Meesho')` falling through to the /website/ alias and
// filing them as 'Website' — the exact §9.1 #8 defect (wrong return policy, wrong invoice
// requested) that this file exists to prevent. Recognising a channel we cannot file is what
// lets the route decline honestly.
//
// Exposed separately so the route can distinguish "bought on Meesho, and we have nowhere
// to file that" (terminal — callback, no ticket, and ops must capture the PURCHASE MONTH/
// YEAR by hand because the warranty clock is not on any ticket) from "we didn't understand
// you" (just ask the caller again). Both still map to null — neither may ever become
// 'Website'. ⛔ And never ask for an 'Other' value instead: cf_purchased_from decides which
// return policy applies and which invoice we request, so an 'Other' bucket would destroy
// that signal for all five brands on this desk and re-open #8 in a new costume.
const UNMAPPED_CHANNELS = /\b(meesho|jabong)\b/i;

/** True if the text names a real truTRTL channel that has no cf_purchased_from value. */
export function isUnmappedChannel(text) {
  return !!text && UNMAPPED_CHANNELS.test(String(text));
}

export function mapPlatform(text) {
  if (!text) return null;
  const t = String(text).trim();
  const exact = PLATFORM_CHOICES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  // Unmapped channels FIRST, exactly as ELLE's fork does for offline retail: "bought it
  // on the Meesho website" must not be dragged to 'Website' by the alias below. Naming a
  // channel we cannot file is a harder fact than any keyword that follows it.
  if (isUnmappedChannel(t)) return null;
  for (const [re, choice] of ALIASES) if (re.test(t)) return choice;
  return null;
}
