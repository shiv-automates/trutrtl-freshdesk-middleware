// POST /freshdesk/register-warranty   (ENABLED — creates a real Freshdesk ticket, type WARRANTY)
//
// ⭐ 2026-07-29 (Manish, meeting decision). A caller who wants to REGISTER a warranty — NOT
//    report a fault — must NOT go through the complaint flow. Tara takes ONLY the name and
//    phone number, tells them to drop a "hi" on WhatsApp so the team continues the warranty
//    process there, and this route drops a WARRANTY-type ticket into the same Freshdesk desk
//    (the `Type` field has a `WARRANTY` value, and there is a dedicated `Warranty` group).
//
// ⚠ THE DESK REQUIRES A PRODUCT ON EVERY TICKET. Verified live against digicart.freshdesk.com:
//    a create is validated in tiers, and even a WARRANTY-type ticket is rejected without the
//    full brand→category→SKU→platform chain (cf_brand121540, cf_product_category, cf_product,
//    cf_purchased_from, cf_given_to_service_partner, cf_group_custom). A warranty registration
//    has none of that, so we fill the chain with a PLACEHOLDER product and shout it in the
//    subject + description. This is safe here in a way it never is for a complaint: a warranty
//    registration dispatches NO technician, so a placeholder product cannot send anyone to the
//    wrong address — and the real product is confirmed later from the invoice on WhatsApp.
//    (Cleaner long-term fix, owner-side: an admin rule making the product chain optional for
//    type=WARRANTY; then this placeholder goes away.)
//
// Flow mirrors register-complaint: auth → unwrap → validate → phone → dedup → create →
//   answer HERE ({ ok:true }) → then, in the background: note → optional auto-close.
//   Bookkeeping must never sit on the path a live caller waits on (the #12106/#12107 lesson).
import { Router } from 'express';
import { config, brandTag, FRESHDESK } from '../lib/config.js';
import { logger, maskPhone } from '../lib/logger.js';
import { requireBearer } from '../lib/auth.js';
import * as fd from '../lib/freshdesk.js';
import { unwrapParams } from '../lib/ravan.js';
import { requiredCustomFields } from '../lib/ticket-fields.js';
import { toStorage, tenDigit, isValidIndianMobile, isPlaceholderNumber } from '../lib/phone.js';
import { normalizeKey } from '../lib/idempotency.js';

export const registerWarrantyRouter = Router();

// The Warranty group on digicart.freshdesk.com (env-overridable). Verified live 2026-07-29.
const WARRANTY_GROUP_ID = Number(process.env.WARRANTY_GROUP_ID) || 81000089594;

// The placeholder product for the required brand→category→SKU chain. It is NEVER treated as
// real: the subject and description say so in capitals, and the ticket is type WARRANTY with a
// `warranty_registration` tag. A warranty registration dispatches nobody, so this cannot
// misroute a technician the way a placeholder on a COMPLAINT would.
const PLACEHOLDER_PRODUCT = 'Ceiling Fan';
const PLACEHOLDER_PLATFORM = 'Website';

const SPOKEN = {
  missing_required: 'I just need your name and number to get this started for you.',
  // Never blame the caller or claim the number is wrong — same rule as the complaint route.
  invalid_phone: 'Let me just take that number again — could you say it digit by digit?',
  freshdesk_error:
    "I'm having trouble noting this on the system right now. Let me take your details and have our team reach you on WhatsApp.",
};
const fail = (reason, extra = {}) => ({ error: true, reason, spoken_hint: SPOKEN[reason], ...extra });

// Short retry-join window so a Ravan re-fire of the same call doesn't create two warranty
// tickets. Keyed on the phone (a warranty registration carries no issue text to distinguish a
// genuine second one, and a caller filing two warranties in 2 minutes is not a real case).
const WARRANTY_DEDUP_MS = Math.min(120000, config.idempotencyWindowMs);
const recentByPhone = new Map(); // tenDigit(phone) -> { id, at }

function dedupLookup(phone) {
  const key = tenDigit(phone);
  if (!key) return null;
  const hit = recentByPhone.get(key);
  if (hit && Date.now() - hit.at < WARRANTY_DEDUP_MS) return hit.id;
  if (hit) recentByPhone.delete(key);
  return null;
}
function dedupRemember(phone, id) {
  const key = tenDigit(phone);
  if (key) recentByPhone.set(key, { id, at: Date.now() });
}

function buildPayload(p) {
  const now = new Date();
  // orderDate:null → the '1900-01-01' sentinel, so nobody reads a real purchase date off this.
  const custom_fields = requiredCustomFields(
    { platform: PLACEHOLDER_PLATFORM, product: PLACEHOLDER_PRODUCT, orderId: '', orderDate: null },
    now,
  );

  const subject = 'WARRANTY REGISTRATION (voice agent) — product to be confirmed from invoice';
  const description = [
    'WARRANTY REGISTRATION requested via the AI voice agent (Tara).',
    '',
    `Name: ${String(p.name).trim()}`,
    `Callback number: ${toStorage(p.phone_number)}`,
    '',
    '⚠ PRODUCT & PLATFORM WERE NOT CAPTURED ON THE CALL — the values in the custom fields are',
    'PLACEHOLDERS only, present because the desk requires them. Do NOT treat them as real.',
    'The customer was asked to send a "hi" on WhatsApp; the team continues the warranty process',
    `there (${config.companyWhatsapp}) and confirms the real product from the invoice.`,
  ].join('\n');

  const tags = ['voice_agent', 'warranty_registration', brandTag];
  if (config.testAutoClose) tags.push('voice_agent_test');

  return {
    name: String(p.name).trim(),
    phone: toStorage(p.phone_number),
    subject,
    description,
    type: 'WARRANTY',
    status: FRESHDESK.status.OPEN,
    priority: FRESHDESK.priority.MEDIUM,
    source: FRESHDESK.source.PHONE,
    group_id: WARRANTY_GROUP_ID,
    custom_fields,
    tags,
  };
}

// ── Background bookkeeping (never on the response path) ──
export const pendingBackgroundWork = new Set();
export async function drainBackgroundWork() {
  while (pendingBackgroundWork.size) await Promise.allSettled([...pendingBackgroundWork]);
}
function runInBackground(label, fn) {
  const task = (async () => {
    try { await fn(); } catch (e) {
      logger.warn({ err: e?.message, label }, 'register-warranty background work failed (ticket already created)');
    }
  })();
  pendingBackgroundWork.add(task);
  task.then(() => pendingBackgroundWork.delete(task));
  return task;
}

async function completeRegistration(id) {
  try {
    await fd.addNote(
      id,
      `Warranty registration via voice agent. Customer asked to send a "hi" on WhatsApp (${config.companyWhatsapp}); team to continue the warranty process and confirm the product from the invoice.`,
      true,
    );
  } catch (e) {
    logger.warn({ err: e?.message, id }, 'register-warranty addNote failed — ticket still created');
  }
  if (config.testAutoClose) {
    try {
      await fd.updateTicket(id, { status: FRESHDESK.status.CLOSED });
      logger.info({ id }, 'TEST_AUTO_CLOSE: warranty test ticket closed');
    } catch (e) {
      logger.warn({ err: e?.message, id }, 'TEST_AUTO_CLOSE warranty close failed');
    }
  }
  logger.info({ id }, 'register-warranty bookkeeping done');
}

registerWarrantyRouter.post('/freshdesk/register-warranty', requireBearer, async (req, res) => {
  const p = unwrapParams(req.body);

  const missing = ['name', 'phone_number'].filter((k) => !p[k] || !String(p[k]).trim());
  if (missing.length) {
    logger.warn({ missing }, 'register-warranty: missing name/phone');
    return res.json(fail('missing_required', { missing }));
  }

  if (!isValidIndianMobile(p.phone_number)) {
    logger.warn(
      { heard: maskPhone(String(p.phone_number)), digits: tenDigit(p.phone_number).length },
      'register-warranty: refusing — the number as heard is not a valid Indian mobile',
    );
    return res.json(fail('invalid_phone'));
  }

  // ⭐ 2026-07-29. A fabricated placeholder (9876543210 etc.) is format-valid but never a real
  // caller — the agent reaches for it when it fires the tool BEFORE asking. Refusing it here is
  // what stopped the duplicate warranty ticket (#12185): a hallucinated call now creates nothing.
  if (isPlaceholderNumber(p.phone_number)) {
    logger.warn(
      { heard: maskPhone(String(p.phone_number)) },
      'register-warranty: refusing — placeholder/fabricated number, not a real caller',
    );
    return res.json(fail('invalid_phone'));
  }

  const existing = dedupLookup(p.phone_number);
  if (existing) {
    logger.info({ reused: true, id: existing }, 'register-warranty deduped (same number, short window)');
    return res.json({ ok: true, warranty_ref: String(existing) });
  }

  try {
    const ticket = await fd.createTicket(buildPayload(p));
    const id = ticket?.id;
    if (!id) throw new Error('no ticket id in response');
    dedupRemember(p.phone_number, id);
    runInBackground('warranty bookkeeping', () => completeRegistration(id));
    logger.info({ id, test: config.testAutoClose }, 'register-warranty created');
    // Tara does NOT read this number out — a warranty registration has no complaint number to
    // give the caller. `ok:true` is all she needs to say the WhatsApp line.
    return res.json({ ok: true, warranty_ref: String(id) });
  } catch (err) {
    logger.error({ err: err?.message }, 'register-warranty failed');
    return res.json(fail('freshdesk_error'));
  }
});
