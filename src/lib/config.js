// Central configuration, read once from the environment.
// Importing this module is side-effect free (safe for unit tests); call
// assertRequiredConfig() from the server entry point to fail fast on missing secrets.
import 'dotenv/config';

const bool = (v, dflt = false) =>
  v == null ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

export const config = {
  // Freshdesk (outgoing) — set FRESHDESK_DOMAIN in the environment (kept out of the repo)
  freshdeskDomain: process.env.FRESHDESK_DOMAIN || '',
  freshdeskApiKey: process.env.FRESHDESK_API_KEY || '',
  freshdeskTimeoutMs: int(process.env.FRESHDESK_TIMEOUT_MS, 3500),
  freshdeskMaxRetries: int(process.env.FRESHDESK_MAX_RETRIES, 1),

  // Ravan (incoming)
  ravanSharedSecret: process.env.RAVAN_SHARED_SECRET || '',

  // Complaint-number scheme
  complaintIdMode: (process.env.COMPLAINT_ID_MODE || 'TICKET_ID').toUpperCase(),
  complaintIdField: process.env.COMPLAINT_ID_FIELD || '',

  // Custom-field keys (real, verified on digicart.freshdesk.com)
  cf: {
    platform: process.env.CF_PLATFORM || 'cf_purchased_from',
    product: process.env.CF_PRODUCT || 'cf_custom_tags',
    brand: process.env.CF_BRAND || 'cf_brand121540',
    brandValue: process.env.CF_BRAND_VALUE || 'truTRTL',
    purchaseDate: process.env.CF_PURCHASE_DATE || 'cf_order_date',
    orderId: process.env.CF_ORDER_ID || 'cf_order_id',
    pin: process.env.CF_PIN || 'cf_pin_code',
    city: process.env.CF_CITY || 'cf_city',
    state: process.env.CF_STATE || 'cf_state',
    servicePartner: process.env.CF_SERVICE_PARTNER || 'cf_given_to_service_partner',
    groupCustom: process.env.CF_GROUP_CUSTOM || 'cf_group_custom',
    // Brand nested chain (required on create): brand → product_category → product(SKU).
    productCategory: process.env.CF_PRODUCT_CATEGORY || 'cf_product_category',
    productSku: process.env.CF_PRODUCT_SKU || 'cf_product',
  },

  // "with digiCART" intake queue + its mirror dropdown value (both required on create).
  defaultGroupId: int(process.env.DEFAULT_GROUP_ID, 81000089580),
  groupCustomValue: process.env.CF_GROUP_CUSTOM_VALUE || 'WITH DIGICART',

  // Behaviour
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  companyWhatsapp: process.env.COMPANY_WHATSAPP || '+91 95991 11390',

  // WHAPI (whapi.cloud) — proactively WhatsApp the customer the document request after registering.
  whapi: {
    enabled: bool(process.env.WHAPI_ENABLED, false),
    token: process.env.WHAPI_TOKEN || '',
    baseUrl: process.env.WHAPI_BASE_URL || 'https://gate.whapi.cloud',
  },
  idempotencyWindowMs: int(process.env.IDEMPOTENCY_WINDOW_MS, 300000),
  statusCacheTtlMs: int(process.env.STATUS_CACHE_TTL_MS, 30000),
  testAutoClose: bool(process.env.TEST_AUTO_CLOSE, false),

  // Server
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  nodeEnv: process.env.NODE_ENV || 'development',
};

// The Freshdesk TAG for our brand, derived ONCE from the configured brand value so that
// nothing anywhere hardcodes it: 'truTRTL' → 'trutrtl'. Freshdesk tags cap at 32 chars.
//
// ⭐ Both routes that tag a ticket import THIS. routes/register-complaint.js used to carry
// the literal 'trutrtl' in its tag list while routes/after-call.js derived its own copy, so
// changing CF_BRAND_VALUE would have left the two routes tagging the SAME desk differently
// — and every saved view, automation and report that filters on the brand tag would then
// see only half of this brand's voice tickets. One derivation, one truth.
export const brandTag = String(config.cf.brandValue || 'brand')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32);

// Freshdesk ticket field constants (fixed across accounts).
export const FRESHDESK = {
  status: { OPEN: 2, PENDING: 3, RESOLVED: 4, CLOSED: 5 },
  source: { PHONE: 3 },
  priority: { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 },
};

/** Throw if a required secret is missing. Call from server bootstrap only. */
export function assertRequiredConfig() {
  const missing = [];
  if (!config.freshdeskDomain) missing.push('FRESHDESK_DOMAIN');
  if (!config.freshdeskApiKey) missing.push('FRESHDESK_API_KEY');
  if (!config.ravanSharedSecret) missing.push('RAVAN_SHARED_SECRET');
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`,
    );
  }
}
