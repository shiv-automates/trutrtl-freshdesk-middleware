// Map free-text platform to the EXACT `cf_purchased_from` dropdown choice on
// digicart.freshdesk.com. Unknown → null (left unset; raw text kept in description).

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

export function mapPlatform(text) {
  if (!text) return null;
  const t = String(text).trim();
  const exact = PLATFORM_CHOICES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  for (const [re, choice] of ALIASES) if (re.test(t)) return choice;
  return null;
}
