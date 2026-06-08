// POST /freshdesk/register-complaint   (ENABLED — creates a real Freshdesk ticket)
// Mirrors digiCART's existing intake shape so voice tickets flow into the same views.
import { Router } from 'express';
import { config, FRESHDESK } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireBearer } from '../lib/auth.js';
import * as fd from '../lib/freshdesk.js';
import { unwrapParams } from '../lib/ravan.js';
import { mapProduct, mapCategory } from '../lib/product-map.js';
import { mapPlatform } from '../lib/platform-map.js';
import { requiredCustomFields } from '../lib/ticket-fields.js';
import { toStorage, tenDigit } from '../lib/phone.js';
import { registerDedup } from '../lib/stores.js';
import { normalizeKey } from '../lib/idempotency.js';
import * as whapi from '../lib/whapi.js';
import { buildDocRequestMessage } from '../lib/whatsapp-message.js';

export const registerComplaintRouter = Router();

const REQUIRED = ['name', 'phone_number', 'product', 'platform', 'issue_description'];

function istParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [dd, mm, yyyy] = f.format(date).split('/');
  return { dd, mm, yyyy };
}

/** YYYY-MM-DD → DD-MM-YYYY for the subject; pass anything else through. */
function toDMY(d) {
  if (!d) return 'NA';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d);
}

function buildPayload(p) {
  const product = mapProduct(p.product);
  const { dd, mm, yyyy } = istParts();
  const orderId = (p.order_id ?? '').toString().trim();

  const subject =
    `Complaint Date- ${dd}.${mm}.${yyyy}, Order Date: ${toDMY(p.purchase_date)} , ` +
    `Order ID- ${orderId || 'NA'}`;

  const installedLine =
    p.installed === true ? 'Installed: yes' :
    p.installed === false ? 'Installed: no / not applicable' : '';

  const description = [
    `Brand: truTRTL`,
    `Product: ${p.product}${product ? '' : ' (uncategorised)'}`,
    `Platform: ${p.platform}`,
    p.purchase_date ? `Purchase date: ${p.purchase_date}` : '',
    orderId ? `Order ID: ${orderId}` : '',
    (p.pincode || p.city || p.state)
      ? `Location: ${[p.city, p.state, p.pincode].filter(Boolean).join(', ')}` : '',
    installedLine,
    '',
    `Issue: ${p.issue_description}`,
    '',
    'Logged by AI voice agent (Tara). Invoice + issue video to follow on WhatsApp.',
  ].filter(Boolean).join('\n');

  const pin = p.pincode != null && String(p.pincode).trim() !== ''
    ? Number(String(p.pincode).replace(/\D/g, '')) : undefined;
  const custom_fields = requiredCustomFields({
    platform: p.platform,
    product: p.product,
    orderId,
    orderDate: p.purchase_date,
    city: p.city,
    state: p.state,
    pin,
  });

  const issueTag = String(p.issue_description).trim().slice(0, 32);
  const tags = ['voice_agent', 'warranty'];
  if (issueTag) tags.push(issueTag);
  if (config.testAutoClose) tags.push('voice_agent_test');

  const payload = {
    name: String(p.name).trim(),
    phone: toStorage(p.phone_number),
    subject,
    description,
    status: FRESHDESK.status.OPEN,
    priority: FRESHDESK.priority.MEDIUM,
    source: FRESHDESK.source.PHONE,
    custom_fields,
    tags,
  };
  if (config.defaultGroupId) payload.group_id = config.defaultGroupId;
  return payload;
}

registerComplaintRouter.post('/freshdesk/register-complaint', requireBearer, async (req, res) => {
  const p = unwrapParams(req.body);
  const missing = REQUIRED.filter((k) => !p[k] || !String(p[k]).trim());
  if (missing.length) {
    return res.status(400).json({ error: `missing required: ${missing.join(', ')}` });
  }

  // Idempotency: same phone + product within the window → reuse the ticket.
  const dedupKey = normalizeKey('reg', tenDigit(p.phone_number), mapProduct(p.product) || p.product);
  const existing = registerDedup.get(dedupKey);
  if (existing) {
    logger.info({ reused: true }, 'register-complaint deduped');
    return res.json({ complaint_number: String(existing) });
  }

  try {
    const ticket = await fd.createTicket(buildPayload(p));
    const id = ticket?.id;
    if (!id) throw new Error('no ticket id in response');

    registerDedup.set(dedupKey, id);

    // Private note recording the pending documents.
    try {
      await fd.addNote(
        id,
        `Awaiting invoice + issue video on WhatsApp (${config.companyWhatsapp}).`,
        true,
      );
    } catch (e) {
      logger.warn({ err: e?.message, id }, 'addNote (awaiting docs) failed — ticket still created');
    }

    // Proactively WhatsApp the customer the document request (per-product instructions + review offer).
    // Best-effort: never fail the registration if WhatsApp is down or disabled.
    try {
      const msg = buildDocRequestMessage({
        name: p.name,
        complaintNumber: id,
        productCategory: mapCategory(p.product),
        platform: mapPlatform(p.platform),
        installed: p.installed,
      });
      const r = await whapi.sendText(p.phone_number, msg);
      if (r?.ok) {
        try {
          await fd.addNote(id, 'Document-request WhatsApp sent to the customer (invoice + video + review-for-extension offer).', true);
        } catch { /* note is informational only */ }
      }
    } catch (e) {
      logger.warn({ err: e?.message, id }, 'whapi doc-request send failed (ticket still created)');
    }

    // TEST SAFETY: immediately close test tickets so live ops isn't disturbed.
    if (config.testAutoClose) {
      try {
        await fd.updateTicket(id, { status: FRESHDESK.status.CLOSED });
        logger.info({ id }, 'TEST_AUTO_CLOSE: test ticket closed');
      } catch (e) {
        logger.warn({ err: e?.message, id }, 'TEST_AUTO_CLOSE close failed');
      }
    }

    logger.info({ id, test: config.testAutoClose }, 'register-complaint created');
    return res.json({ complaint_number: String(id) });
  } catch (err) {
    logger.error({ err: err?.message }, 'register-complaint failed');
    return res.json({ error: true });
  }
});
