// Builds the dynamic, per-product document-request WhatsApp message sent right after a
// complaint is registered. Pulls the product-specific video framing from KB §5 so the
// customer knows exactly what to record, and includes the +6-month-for-a-review offer.

// Keyed by the cf_product_category value (mapCategory output).
const VIDEO_FRAMING = {
  'Ceiling Fans':
    'a short video: show the switchboard, switch the fan on with the regulator, then show the fan — so we can clearly see it’s not running / running slow',
  Kettle:
    'a short video of the kettle with water in it, switched on, showing the problem (let it run long enough to show it turn on, then the issue)',
  'Egg Boilers':
    'a short video of the egg boiler with water in it, switched on, showing the problem',
  'Air fryer':
    'a short video showing the plug, the switchboard, the screen, and the fault',
  'Sandwich Maker':
    'clear photos of the damaged part (e.g. the hinge/back) and a short clip of it powering on',
  'Mixer Grinder':
    'a short video of it running and the issue (smoke / wrong rotation / not turning on)',
  'Gas Stoves':
    'a short video showing the burners and the exact problem',
};

/**
 * @param {object} o
 * @param {string} o.name
 * @param {string|number} o.complaintNumber
 * @param {string} [o.productCategory]  cf_product_category value
 * @param {string} [o.platform]         mapped platform
 * @param {boolean} [o.installed]
 */
export function buildDocRequestMessage(o = {}) {
  const name = (o.name && String(o.name).trim().split(/\s+/)[0]) || 'there';
  const platform = o.platform || 'the platform you bought it from';
  let framing = VIDEO_FRAMING[o.productCategory];
  if (!framing) framing = 'a short video clearly showing the problem';
  // For uninstalled items, photos are fine.
  if (o.installed === false && o.productCategory === 'Ceiling Fans') {
    framing = 'a few clear photos from different angles (since it’s not installed)';
  }

  return [
    `Hi ${name}, this is *True Turtle* (truTRTL) support 🐢`,
    ``,
    `Your complaint *#${o.complaintNumber}* is registered ✅`,
    ``,
    `To move it forward quickly, please reply *here* with:`,
    `1️⃣ Your *invoice* (the tax invoice from ${platform})`,
    `2️⃣ ${framing}`,
    ``,
    `⭐ Bonus: leave us a quick *review on ${platform}* and get *6 extra months of warranty*.`,
    ``,
    `We’ll take it forward as soon as we get these. Thank you!`,
  ].join('\n');
}
