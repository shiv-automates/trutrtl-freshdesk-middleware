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
  // ⚠ KEPT ON PURPOSE (2026-07-20). truTRTL no longer sells gas stoves, but the 'Gas Stoves'
  // node is deliberately still filable for people who already own one — see the long note on
  // TRUTRTL_CATEGORIES['Gas Stoves'] in product-map.js. If a legacy stove ticket can be
  // created, its document-request message must not fall through to the generic framing.
  // Note what this line is and is not: it asks the customer to SHOW us the fault. It carries
  // no specification, no troubleshooting and no fault list — we hold none for this product
  // and never will. Delete this row only when the node itself is retired.
  'Gas Stoves':
    'a short video showing the burners and the exact problem',
  // ⭐ M-10 (2026-07-18) — deferred until the 'Electric chopper' node existed; it does now.
  // ⚠ KEYED 'Electric chopper' — LOWERCASE c. This map is looked up by exact key on the
  // cf_product_category value register-complaint.js passes in (mapCategory output). The
  // cf_custom_tags spelling of the same product is 'Electric Chopper' with a CAPITAL C, and
  // using it here would miss silently and send the generic framing instead of failing.
  //
  // The KB's FIRST battery product, so the useful shots are not the ones above. THREE
  // conditions stop this chopper starting and NONE of them is a fault: a flat battery, a
  // head that is not locked on, or the unit still connected to its charger (it will not run
  // while charging). A photo of a still bowl rules out none of them, so ops cannot call it
  // warranty without seeing them ruled out on video — hence the LED, the locked head, and a
  // press-and-hold long enough to show what the motor actually does.
  'Electric chopper':
    'a short video with the chopper OFF the charger, showing: the charging LED (so we can see '
    + 'the battery state), the motor head locked on to the 250 ml bowl, the blade inside the '
    + 'bowl, and then pressing and holding the button — hold it long enough to show whether the '
    + '30 W motor runs, stalls or does nothing',
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
