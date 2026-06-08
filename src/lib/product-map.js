// Map free-text product (what the caller says / what the LLM extracts) to the
// EXACT `cf_custom_tags` dropdown choice on digicart.freshdesk.com.
// If we can't confidently map it, return null and leave the field unset (the raw
// text still goes into the ticket description so nothing is lost).

export const PRODUCT_CHOICES = [
  'Gas Stove', 'Egg boiler', 'Induction', 'Iron', 'Sandwich Maker',
  'Ceiling Fan', 'Cooker', 'Kettle', 'Air fryer', 'Mixer Grinder',
];

// Ordered keyword → choice rules (first match wins).
const RULES = [
  [/\bair\s*fry/i, 'Air fryer'],
  [/\b(ceiling|pedestal|wall|table)?\s*fan\b/i, 'Ceiling Fan'],
  [/\bkettle\b/i, 'Kettle'],
  [/\begg\b/i, 'Egg boiler'],
  [/\b(sandwich|grill|toast|waffle)\b/i, 'Sandwich Maker'],
  [/\b(mixer|grinder|juicer|blender)\b/i, 'Mixer Grinder'],
  [/\binduction\b/i, 'Induction'],
  [/\b(pressure\s*)?cooker\b/i, 'Cooker'],
  [/\b(gas\s*stove|stove|cooktop|hob)\b/i, 'Gas Stove'],
  [/\biron\b/i, 'Iron'],
];

export function mapProduct(text) {
  if (!text) return null;
  const t = String(text).trim();
  // Exact (case-insensitive) match to a known choice.
  const exact = PRODUCT_CHOICES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  for (const [re, choice] of RULES) if (re.test(t)) return choice;
  return null;
}

// ── Brand nested chain: cf_product_category (level 2) + cf_product / SKU (level 3) ──
// These are the EXACT truTRTL values on digicart.freshdesk.com (verified live).
export const TRUTRTL_CATEGORIES = {
  'Ceiling Fans': ['Trutrtl-Smart-1200 MM', 'Trutrtl-Wave-600 MM', 'Trutrtl-Ultra-1200 MM'],
  Kettle: ['Multipurpose-1.3Kettle', 'Electric-1.5 Kettle'],
  'Egg Boilers': ['7Egg Plastic - White', '7Egg Plastic - Black', '14Egg Plastic - Black', 'Trutrtl-7Egg-Mrb'],
  'Air fryer': ['Digital(KZ-4505 A1)', 'Manual(KZ-4505 M)', 'Trutrtl-Airfryer-12L'],
  'Sandwich Maker': ['Toast-Sandwich Maker', 'Grill-Sandwich Maker', '3-in-1 Sandwich Maker'],
  'Mixer Grinder': ['Trutrtl-Nutri-Insta-2Jar', 'Trutrtl-Nutri-Insta-3Jar'],
  'Gas Stoves': ['Shakti 2B', 'Shakti 3B', 'Shakti 4B'],
};

const CATEGORY_RULES = [
  [/\bair\s*fry/i, 'Air fryer'],
  [/\b(ceiling|pedestal|wall|table)?\s*fan\b/i, 'Ceiling Fans'],
  [/\bkettle\b/i, 'Kettle'],
  [/\begg\b/i, 'Egg Boilers'],
  [/\b(sandwich|grill|toast|waffle)\b/i, 'Sandwich Maker'],
  [/\b(mixer|grinder|juicer|blender)\b/i, 'Mixer Grinder'],
  [/\b(gas\s*stove|stove|cooktop|hob)\b/i, 'Gas Stoves'],
];

// Representative default SKU per category (used when the caller can't give a model).
const DEFAULT_SKU = {
  'Ceiling Fans': 'Trutrtl-Smart-1200 MM',
  Kettle: 'Electric-1.5 Kettle',
  'Egg Boilers': '7Egg Plastic - White',
  'Air fryer': 'Manual(KZ-4505 M)',
  'Sandwich Maker': 'Grill-Sandwich Maker',
  'Mixer Grinder': 'Trutrtl-Nutri-Insta-2Jar',
  'Gas Stoves': 'Shakti 2B',
};

/** Free-text product → a valid truTRTL product category (plural), or null. */
export function mapCategory(text) {
  if (!text) return null;
  const t = String(text).trim();
  const exact = Object.keys(TRUTRTL_CATEGORIES).find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  for (const [re, c] of CATEGORY_RULES) if (re.test(t)) return c;
  return null;
}

/** Pick a valid SKU for a category; honour an optional caller-supplied model. */
export function mapSku(category, model) {
  const skus = TRUTRTL_CATEGORIES[category] || [];
  if (model) {
    const m = String(model).toLowerCase();
    const hit = skus.find((s) => s.toLowerCase().includes(m) || m.includes(s.toLowerCase()));
    if (hit) return hit;
  }
  return DEFAULT_SKU[category] || skus[0] || null;
}
