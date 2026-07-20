// ⭐ M-10 — the per-product video framing on the document-request WhatsApp message.
//
// The framing is what decides whether ops can settle a warranty claim from the video or has
// to chase the customer for a second one. VIDEO_FRAMING is looked up by EXACT KEY on the
// cf_product_category value (register-complaint.js passes `category`, i.e. mapCategory
// output), and a key that does not match falls back to a generic line WITHOUT failing — so
// a mis-cased key is invisible in production and has to be caught here.
//
// ⚠ That is a live hazard for the chopper specifically: cf_product_category says
// 'Electric chopper' (lowercase c) while cf_custom_tags says 'Electric Chopper' (capital C),
// and only the first one is a valid key for this map.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDocRequestMessage } from '../../src/lib/whatsapp-message.js';
import { mapCategory, TRUTRTL_CATEGORIES } from '../../src/lib/product-map.js';

// The fallback line. Its appearance for a category we DO have framing for is the bug.
const GENERIC = 'a short video clearly showing the problem';
const BASE = { name: 'Asha Kumar', complaintNumber: 123456, platform: 'Amazon' };

test('⭐ M-10: a chopper complaint gets the CHOPPER framing, keyed on cf_product_category', () => {
  const category = mapCategory('chopper grinder');
  assert.equal(category, 'Electric chopper', 'the key VIDEO_FRAMING must be keyed on — lowercase c');

  const msg = buildDocRequestMessage({ ...BASE, productCategory: category });
  assert.equal(
    msg.includes(GENERIC), false,
    'the chopper fell through to the generic framing. VIDEO_FRAMING is keyed by the '
    + "cf_product_category value ('Electric chopper', lowercase c) — the cf_custom_tags "
    + "spelling ('Electric Chopper', capital C) misses silently and sends this instead.",
  );

  // The four shots a warranty decision needs on a RECHARGEABLE unit: a flat battery, an
  // unlocked head and "still on the charger" all look identical to a dead motor, and none of
  // them is a fault. If any of these stops being asked for, ops is back to guessing.
  assert.match(msg, /charging LED/i, 'the video must show the charging LED (battery state)');
  assert.match(msg, /head locked on/i, 'the video must show the motor head locked on');
  assert.match(msg, /off the charger/i, 'it will not run while connected to the charger');
  assert.match(msg, /pressing and holding/i, 'the button is press-and-hold, not a switch');
  assert.match(msg, /blade/i, 'the blade must be visible in the bowl');
  // The two specs the KB actually carries — no more than that is invented.
  assert.match(msg, /250 ml/, 'the 250 ml bowl');
  assert.match(msg, /30 W/, 'the 30 W motor');

  // The rest of the message is unchanged: it still carries the real complaint number, the
  // invoice ask and the review offer, on the platform the customer bought from.
  assert.match(msg, /#123456/);
  assert.match(msg, /Asha/);
  assert.match(msg, /invoice/i);
  assert.match(msg, /Amazon/);
});

test('⭐ M-10: every filable category has its own framing — none falls back to the generic line', () => {
  // One row per live category, checked through the public builder rather than the private
  // map, so a key that is present but mis-cased still fails.
  for (const category of Object.keys(TRUTRTL_CATEGORIES)) {
    const msg = buildDocRequestMessage({ ...BASE, productCategory: category });
    assert.equal(
      msg.includes(GENERIC), false,
      `"${category}" has no VIDEO_FRAMING row (or the key is cased differently from the live `
      + 'cf_product_category value), so the customer is asked for a generic video and ops '
      + 'gets a clip it cannot judge warranty from.',
    );
  }
});

test('⭐ M-10: an unmapped or missing category still sends a usable message', () => {
  // Toaster / Water Boiler have no category at all, and the route can call this before a
  // category is known. The generic framing is the CORRECT answer here — never a crash, and
  // never another product's instructions.
  assert.ok(buildDocRequestMessage({ ...BASE, productCategory: 'Toaster' }).includes(GENERIC));
  assert.ok(buildDocRequestMessage(BASE).includes(GENERIC));
  // An uninstalled ceiling fan is the one documented override, and it still stands.
  assert.match(
    buildDocRequestMessage({ ...BASE, productCategory: 'Ceiling Fans', installed: false }),
    /clear photos from different angles/,
  );
});
