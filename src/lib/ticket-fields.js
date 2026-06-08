// Builds the set of custom fields that digicart.freshdesk.com REQUIRES on ticket
// creation (verified live: cf_purchased_from, cf_brand121540, cf_order_date,
// cf_order_id, cf_city, cf_state, cf_pin_code, cf_given_to_service_partner,
// cf_group_custom). Missing values get clear placeholders so creation never 400s;
// ops reconciles real values from the WhatsApp invoice. cf_custom_tags (product)
// is NOT required, so it's only set when we can map it.
import { config } from './config.js';
import { mapPlatform } from './platform-map.js';
import { mapCategory, mapSku } from './product-map.js';

/** YYYY-MM-DD for "today" in the configured timezone (en-CA renders ISO date). */
export function todayISO(tz = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/**
 * @param {object} o
 * @param {string} [o.platform]  free-text platform (mapped to a dropdown choice)
 * @param {string} [o.product]   free-text product (mapped; optional field)
 * @param {string} [o.orderId]
 * @param {string} [o.orderDate] YYYY-MM-DD
 * @param {string} [o.city]
 * @param {string} [o.state]
 * @param {number} [o.pin]
 */
export function requiredCustomFields(o = {}) {
  const cf = config.cf;
  // Brand nested chain — all three levels must be a valid, consistent path.
  const category = mapCategory(o.product) || 'Ceiling Fans'; // safe fallback (Ravan enum prevents this)
  const sku = mapSku(category, o.model);
  return {
    [cf.brand]: cf.brandValue,                                  // truTRTL  (level 1)
    [cf.productCategory]: category,                             // level 2 (required)
    [cf.productSku]: sku,                                       // level 3
    [cf.platform]: mapPlatform(o.platform) || 'Website',        // required dropdown
    [cf.servicePartner]: 'No',                                  // required dropdown
    [cf.groupCustom]: config.groupCustomValue,                  // required dropdown (WITH DIGICART)
    [cf.purchaseDate]: isISODate(o.orderDate) ? o.orderDate : todayISO(),
    [cf.orderId]: (o.orderId && String(o.orderId).trim()) || 'NA',
    [cf.city]: (o.city && String(o.city).trim()) || 'NA',
    [cf.state]: (o.state && String(o.state).trim()) || 'NA',
    [cf.pin]: Number.isFinite(o.pin) ? o.pin : 0,
  };
}
