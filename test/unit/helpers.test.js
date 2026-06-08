// Unit tests for the pure helpers. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clean, tenDigit, variants, toStorage, isValidIndianMobile } from '../../src/lib/phone.js';
import { stripHtml, toOneSentence } from '../../src/lib/html-strip.js';
import { statusLabel, nextStep, isClosed } from '../../src/lib/status-map.js';
import { daysSince, daysSincePhrase } from '../../src/lib/time-since.js';
import {
  mapProduct, PRODUCT_CHOICES, mapCategory, mapSku, TRUTRTL_CATEGORIES,
} from '../../src/lib/product-map.js';
import { mapPlatform, PLATFORM_CHOICES } from '../../src/lib/platform-map.js';
import { unwrapParams, safeLatestNote, formatStatus, parseAfterCall } from '../../src/lib/ravan.js';
import { requiredCustomFields } from '../../src/lib/ticket-fields.js';

test('phone: tenDigit + variants + storage', () => {
  assert.equal(tenDigit('+91-9876-543-210'), '9876543210');
  assert.equal(tenDigit('98 765 43210'), '9876543210');
  assert.equal(tenDigit('919876543210'), '9876543210');
  assert.equal(toStorage('9876543210'), '+919876543210');
  assert.ok(variants('+919876543210').includes('9876543210'));
  assert.ok(variants('9876543210').includes('+919876543210'));
  assert.equal(clean('+91 (98) 765'), '+9198765');
  assert.equal(isValidIndianMobile('9876543210'), true);
  assert.equal(isValidIndianMobile('1234567890'), false);
});

test('html-strip: tags, entities, trimming', () => {
  assert.equal(stripHtml('<p>Hello&nbsp;<b>world</b></p>'), 'Hello world');
  assert.equal(stripHtml("Dear&#39;s &amp; co"), "Dear's & co");
  const long = 'Technician visit being scheduled for your area. ' + 'x'.repeat(300);
  assert.ok(toOneSentence(long, 200).length <= 201);
  assert.equal(toOneSentence('Short note.'), 'Short note.');
});

test('status-map: labels + next steps + closed', () => {
  assert.equal(statusLabel(2), 'registered and open');
  assert.equal(statusLabel(3), 'in progress');
  assert.equal(statusLabel(5), 'completed and closed');
  assert.match(nextStep(2), /technician/i);
  assert.equal(isClosed(5), true);
  assert.equal(isClosed(2), false);
});

test('time-since: day math + phrasing', () => {
  const now = new Date('2026-06-08T12:00:00Z');
  assert.equal(daysSince('2026-06-08T05:00:00Z', 'Asia/Kolkata', now), 0);
  assert.equal(daysSince('2026-06-04T05:00:00Z', 'Asia/Kolkata', now), 4);
  assert.equal(daysSince(null, 'Asia/Kolkata', now), null);
  assert.equal(daysSincePhrase(0), 'today');
  assert.equal(daysSincePhrase(1), 'yesterday');
  assert.equal(daysSincePhrase(4), '4 days ago');
});

test('product-map: free text → exact dropdown choice', () => {
  assert.equal(mapProduct('48 inch ceiling fan'), 'Ceiling Fan');
  assert.equal(mapProduct('1.5L electric kettle'), 'Kettle');
  assert.equal(mapProduct('egg boiler 7 egg'), 'Egg boiler');
  assert.equal(mapProduct('digital air fryer'), 'Air fryer');
  assert.equal(mapProduct('grill sandwich maker'), 'Sandwich Maker');
  assert.equal(mapProduct('mixer grinder'), 'Mixer Grinder');
  assert.equal(mapProduct('something we do not sell'), null);
  for (const c of PRODUCT_CHOICES) assert.equal(mapProduct(c), c);
});

test('platform-map: free text → exact dropdown choice', () => {
  assert.equal(mapPlatform('amazon'), 'Amazon');
  assert.equal(mapPlatform('bought on flipkart'), 'Flipkart');
  assert.equal(mapPlatform('zepto'), 'Zepto');
  assert.equal(mapPlatform('the website'), 'Website');
  assert.equal(mapPlatform('swiggy instamart'), 'Swiggy');
  assert.equal(mapPlatform('big basket'), 'BigBasket');
  assert.equal(mapPlatform('unknown shop'), null);
  for (const c of PLATFORM_CHOICES) assert.equal(mapPlatform(c), c);
});

test('product-map: nested brand chain (category + SKU)', () => {
  assert.equal(mapCategory('48 inch ceiling fan'), 'Ceiling Fans');
  assert.equal(mapCategory('egg boiler 7 egg'), 'Egg Boilers');
  assert.equal(mapCategory('1.5L kettle'), 'Kettle');
  assert.equal(mapCategory('grill sandwich maker'), 'Sandwich Maker');
  assert.equal(mapCategory('nonsense'), null);
  // SKU must be a valid member of the category
  assert.ok(TRUTRTL_CATEGORIES['Ceiling Fans'].includes(mapSku('Ceiling Fans')));
  assert.equal(mapSku('Kettle', '1.5'), 'Electric-1.5 Kettle');
  assert.ok(TRUTRTL_CATEGORIES['Air fryer'].includes(mapSku('Air fryer')));
});

test('ticket-fields: requiredCustomFields produces a valid, complete payload', () => {
  const f = requiredCustomFields({ platform: 'zepto', product: 'ceiling fan', orderId: 'X1', orderDate: '2026-04-01', city: 'Pune', state: 'MH', pin: 411001 });
  assert.equal(f.cf_brand121540, 'truTRTL');
  assert.equal(f.cf_product_category, 'Ceiling Fans');
  assert.ok(TRUTRTL_CATEGORIES['Ceiling Fans'].includes(f.cf_product));
  assert.equal(f.cf_purchased_from, 'Zepto');
  assert.equal(f.cf_given_to_service_partner, 'No');
  assert.equal(f.cf_group_custom, 'WITH DIGICART');
  assert.equal(f.cf_order_id, 'X1');
  assert.equal(f.cf_order_date, '2026-04-01');
  assert.equal(f.cf_pin_code, 411001);
  // placeholders when missing
  const g = requiredCustomFields({ product: 'kettle' });
  assert.equal(g.cf_order_id, 'NA');
  assert.equal(g.cf_city, 'NA');
  assert.equal(g.cf_pin_code, 0);
  assert.equal(g.cf_purchased_from, 'Website');
  assert.match(g.cf_order_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('ravan: unwrapParams handles flat + wrapped', () => {
  assert.deepEqual(unwrapParams({ complaint_number: '123' }), { complaint_number: '123' });
  assert.deepEqual(unwrapParams({ args: { complaint_number: '123' } }), { complaint_number: '123' });
  assert.deepEqual(unwrapParams({ parameters: { phone_number: '9' } }), { phone_number: '9' });
  assert.deepEqual(unwrapParams(null), {});
});

test('ravan: safeLatestNote only reads customer-facing notes', () => {
  const convos = [
    { body_text: 'Internal: tech assigned', private: true, created_at: '2026-06-01T10:00:00Z' },
    { body_text: 'Dear Customer, your technician visit is scheduled tomorrow.', private: true, created_at: '2026-06-02T10:00:00Z' },
    { body_text: 'It started now 19:05', private: true, created_at: '2026-06-03T10:00:00Z' },
  ];
  // newest safe note is the "Dear Customer" one (the terse one is skipped)
  assert.match(safeLatestNote(convos), /technician visit is scheduled/);
  // all-internal → null
  assert.equal(safeLatestNote([{ body_text: 'terse', private: true, created_at: '2026-06-03T10:00:00Z' }]), null);
  // public reply is allowed
  assert.match(
    safeLatestNote([{ body_text: 'We have shipped your replacement.', private: false, created_at: '2026-06-03T10:00:00Z' }]),
    /replacement/,
  );
});

test('ravan: formatStatus produces the voice shape', () => {
  const ticket = {
    id: 11914,
    status: 3,
    created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    custom_fields: { cf_custom_tags: 'Ceiling Fan' },
    conversations: [
      { body_text: 'Dear Customer, a technician will visit soon.', private: true, created_at: new Date().toISOString() },
    ],
  };
  const out = formatStatus(ticket);
  assert.equal(out.found, true);
  assert.equal(out.complaint_number, '11914');
  assert.equal(out.product, 'Ceiling Fan');
  assert.equal(out.status_label, 'in progress');
  assert.ok(out.days_since_registered >= 3 && out.days_since_registered <= 5);
  assert.match(out.latest_update, /technician/);
  assert.ok(out.expected_next_step);
  assert.deepEqual(formatStatus(null), { found: false });
});

test('ravan: parseAfterCall is defensive across shapes', () => {
  const wrapped = parseAfterCall({
    event: 'call.completed',
    data: {
      call_session_id: 'abc',
      caller_number: '+919876543210',
      summary: 'Fan issue',
      post_call_analysis: { sentiment: 'negative', next_steps: 'send video' },
      transcripts: [{ role: 'agent', message: { content: 'Hello' } }, { role: 'user', content: 'Hi' }],
    },
  });
  assert.equal(wrapped.callId, 'abc');
  assert.equal(wrapped.phone, '+919876543210');
  assert.equal(wrapped.sentiment, 'negative');
  assert.equal(wrapped.nextSteps, 'send video');

  const flat = parseAfterCall({ call_id: 'x1', phone: '9876543210', summary: 'hi', sentiment: 'positive' });
  assert.equal(flat.callId, 'x1');
  assert.equal(flat.phone, '9876543210');
  assert.equal(flat.sentiment, 'positive');
});
