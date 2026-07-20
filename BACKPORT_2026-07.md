# Backport 2026-07 — security fixes, deploy gate, go-live checklist

Four fixes landed in `src/` this cycle: the identity gate + brand filter on status lookup, honest
failure on registration, and an auth fix on the after-call webhook. **These fixes originated in the
ELLE Home fork** (`ellehome-freshdesk-middleware`, built to avoid cloning truTRTL's known defects) and
are backported here to bring truTRTL to parity. This is the runbook for going live with them.

---

## 1. What changed and why

### 1.1 The identity gate (`get_complaint_status`)
**Closes:** a caller who reads out any complaint/phone combination could hear another customer's full
case detail — product, status, latest note — with nothing but prompt discipline standing in the way.

`get_complaint_status` now takes an optional `caller_stated_name`. The middleware compares it to the
ticket's requester **server-side** (`src/lib/ravan.js` → `namesMatch()` / `formatStatus()`) and returns
only a boolean, `name_matches`. The real requester name is **never** included in any response — if it
were, it would sit in the voice agent's context, and a name in context is a name that can be read out.

When `name_matches` is `false` (wrong name, or no name sent), the response is reduced to exactly:
```json
{ "found": true, "complaint_number": "11914", "name_matches": false }
```
No `status_label`, no `product`, no `latest_update`. Tara may confirm a complaint **exists**; she may
not describe it. Full detail is added only after the gate passes.

### 1.2 The brand filter (`get_complaint_status`, `/ravan/after-call`)
**Closes:** `digicart.freshdesk.com` is one helpdesk shared by four brands (MILTON, APARNA, FKSB,
truTRTL) over one ticket-id sequence (~12k tickets, ~5 digits). A truTRTL caller reading out any
plausible number could resolve *another brand's* ticket, and nothing checked that before formatting a
response from it.

Every ticket fetched — by id, by phone-derived ticket list, or via the after-call note path — is now
proven to carry `cf_brand121540 === 'truTRTL'` (`isBrandTicket()` in `src/lib/ravan.js`) before a single
field of it is used. **A ticket belonging to another brand is answered identically to a genuine
miss — `{ "found": false }`.** Tara cannot distinguish "no such complaint" from "that's someone else's
complaint," by design; disclosing the distinction would itself leak information about another brand's
customer.

### 1.3 Honest registration failure (`register_complaint`)
**Closes:** the route used to file whatever it was handed. `Induction`, `Cooker` and `Iron` are real
truTRTL products in Tara's enum and in the `cf_custom_tags` dropdown, but have no node in the
7-category Brand→Category→SKU tree — so a complaint about any of them was silently filed as a
**Ceiling Fan** with the fabricated model `Trutrtl-Smart-1200 MM`, and Tara read back a number as if it
were correct. Separately, `Meesho` and `Jabong` are real truTRTL sales channels (the KB's own "sold on"
list) with no value on `cf_purchased_from` — a complaint from either was silently filed as `Website`,
pushing the customer into truTRTL's own 7-day return flow and asking them for the wrong invoice.

Both silent fallbacks (`mapCategory(...) || 'Ceiling Fans'` and `mapPlatform(...) || 'Website'`) are
gone. `src/lib/ticket-fields.js` now throws (or, via `validateComplaint()`, pre-checks) instead of
defaulting. The route (`src/routes/register-complaint.js`) returns a stable `reason` and a
call-safe `spoken_hint`, and **creates nothing**:

| `reason` | Trigger | Recoverable? |
|---|---|---|
| `missing_required` | A required field (`name`, `phone_number`, `product`, `platform`, `issue_description`) is empty | Yes — Tara re-asks and calls again |
| `unmapped_product` | Product text doesn't map to any of the 10 `cf_custom_tags` choices | Yes |
| `category_unavailable` | Product **is** real (Induction/Cooker/Iron) but has no node in the brand tree | **No — terminal, callback, no ticket** |
| `unmapped_platform` | Platform text doesn't map to any `cf_purchased_from` choice | Yes |
| `unmapped_channel` | Platform **is** real (Meesho/Jabong) but has no `cf_purchased_from` value | **No — terminal, callback, no ticket** |
| `freshdesk_error` | Freshdesk itself rejected or timed out on the create | **No — terminal, callback, no ticket** |

**A failure response never carries a `complaint_number`.** For the terminal reasons, everything the
caller gave (name, callback number, product/platform as stated, issue, location) is written to the
service log (`logUnfiled()`) so ops can file it by hand — that log entry is the only record the
complaint ever happened, since no ticket exists.

### 1.4 Auth fix on the after-call webhook (`/ravan/after-call`)
**Closes:** the previous guard only rejected a request when `?key` was **present and wrong** —
`if (secret && req.query.key && req.query.key !== secret) → 401`. Omitting the query string entirely
walked straight through, unauthenticated, into a live production helpdesk shared by four brands.

The guard now reads: if a secret is configured, the key must be **present and match**
(`src/lib/auth.js`'s `safeEqual()`, the same constant-time compare the Bearer routes use), or the
request gets a `401` before any Freshdesk write happens. **The webhook URL must now include
`?key=<RAVAN_SHARED_SECRET>`.** A URL saved without it will 401 on every call once this code deploys.

---

## 2. DEPLOY GATE — read before you deploy

**Do not deploy this code to `https://trutrtl-support.digidzn.com` (the DIGIDZN VPS — see
[`VPS_DEPLOY.md`](./VPS_DEPLOY.md); the Render host is retired) until the Ravan agent
config AND the system prompt are updated in lockstep.** The tool contract changed:

- `get_complaint_status` now expects `caller_stated_name` to get any case detail back.
- The after-call webhook now requires `?key=` in its URL or it 401s.

**Deploying the code alone — without updating the Ravan function schema, the after-call webhook URL,
and Tara's Phase 6 sequencing — makes Tara unable to report any complaint status on a live call.** Her
current prompt (`truTRTL_Inbound_Voice_Agent_System_Prompt.md`, Phase 6) calls `get_complaint_status`
at **step 6.3**, before it has asked for the caller's name at **step 6.4**. Against the new code, that
first call always returns `name_matches:false` with no product/status/update — Tara has nothing to say,
on every single status call, until the prompt changes.

This file, `RAVAN_CUSTOM_FUNCTIONS.md`, and the code must move together. Do not ship one without the
other two.

---

## 3. Ordered go-live checklist

Work top to bottom.

1. **Update the Ravan function schema** for `get_complaint_status` — add the `caller_stated_name`
   parameter exactly as specified in `RAVAN_CUSTOM_FUNCTIONS.md` §Function 1, and update its
   description so Tara knows to send the name and to withhold detail on `name_matches:false`.
2. **Update the system prompt's Phase 6 sequencing** (`truTRTL_Inbound_Voice_Agent_System_Prompt.md`) —
   either move the name question ahead of the 6.3 tool call so `caller_stated_name` is sent on the
   first (and only) call, or keep the current order and add a **second** call to
   `get_complaint_status` at 6.4 once the name is known. The second call is a cache hit
   (`STATUS_CACHE_TTL_MS`, 30s default — the middleware caches the *ticket*, not the answer) and does
   not spend extra budget against the shared ~40 req/min Freshdesk limit.
3. **Add `?key=<RAVAN_SHARED_SECRET>` to the after-call webhook URL** in the Ravan agent settings.
   Confirm the UI actually lets you save a query string on that field before relying on it.
4. **Deploy** the code to the VPS — `docker compose up -d --build` per [`VPS_DEPLOY.md`](./VPS_DEPLOY.md).
   Confirm `WHAPI_ENABLED=true` (D-2) and `TEST_AUTO_CLOSE=true` (D-3) in the same window, then point
   the Ravan function URLs at `https://trutrtl-support.digidzn.com` and re-check the after-call
   webhook still carries `?key=` after the host change.
5. **Re-run the acceptance matrix below** on a real call (or via `test/curl-examples.sh` for the
   non-voice parts) before calling this go-live complete.

---

## 4. Acceptance matrix — verify on a real call

| # | Case | Steps | Expected |
|---|---|---|---|
| 1 | Status by complaint number, matching name | Give a real truTRTL ticket number; when asked, give the name it's actually registered under | Full detail read back: product, status, days since registered, latest update, next step |
| 2 | Status by complaint number, wrong name | Same ticket number; give a name that does **not** match the requester | `name_matches:false` — Tara reveals nothing case-specific, offers a callback |
| 3 | Status by a cross-brand ticket id | Give a ticket id known to belong to MILTON/APARNA/FKSB, not truTRTL | Indistinguishable from a genuine miss — Tara says "I'm not finding a complaint under that," never hints it belongs to another brand |
| 4 | Register an Induction complaint | Give product = Induction, a valid platform, and all other required fields | Tara declines honestly (`category_unavailable`), takes a callback, and **no complaint number is read out** — confirm no ticket was created in Freshdesk |
| 5 | Register a Meesho purchase | Give platform = Meesho (or "bought it on Meesho"), a valid product, and all other required fields | Tara declines honestly (`unmapped_channel`), takes a callback — confirm it is **not** silently filed as `Website` in Freshdesk |
| 6 | After-call webhook, with `?key=` | Let a call complete normally with the corrected webhook URL | `200 {ok:true}`; a private note (or new ticket) lands on the caller's truTRTL record |
| 7 | After-call webhook, without `?key=` | POST the webhook URL with the `?key=` param stripped (e.g. via curl) | `401` — confirms the auth hole is actually closed, not just documented as closed |

---

## 5. Provenance

All four fixes were designed and verified first in the ELLE Home fork
(`C:/Users/hp/.opencode/DIGIDZN/ElleHome/ellehome-freshdesk-middleware`), which was built specifically
to avoid inheriting truTRTL's known defects (see that repo's `RAVAN_CUSTOM_FUNCTIONS_ELLE.md` for the
original writeup). This backport brings truTRTL's live code to parity with that fork. Where the two
brands' behaviour differs on purpose (e.g. truTRTL keeps its `installed` field for ceiling fans; ELLE
does not), only the shared security fixes were ported — brand-specific product/platform trees and
prompt content were left untouched.
