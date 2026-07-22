# Ravan / Agni — Custom Function configs (paste into the Agent Builder)

> **2026-07 backport:** four security fixes landed in `src/` (identity gate + brand filter on status
> lookup, honest failure on register, auth fix on the after-call webhook). This file already reflects
> the new contract. Before deploying, read **[BACKPORT_2026-07.md](./BACKPORT_2026-07.md)** — the code
> must not go live until this config and Tara's system prompt (Phase 6) are updated in lockstep.
>
> **2026-07 release (July change plan) — the contract moved again.** Function 2's schema below gained
> **`model`**, **`caller_id`** and the **`Electric Chopper`** enum value (**R-4**), registration gained a new
> failure reason **`invalid_phone`** (**M-2**), and both function timeouts go **8000 → 12000 ms**
> paired with a *lowered* `FRESHDESK_TIMEOUT_MS` (**M-9 / R-5**). None of these is backward-optional:
> **leaving the `product` enum behind the code is what files a fabricated ticket** — see the lockstep
> box under Function 2, and §*Function timeouts* for the arithmetic.
>
> **2026-07-18 — F-1 and F-2 are DONE; M-12 has shipped.** The desk admin added the Electric Chopper
> node live on `digicart.freshdesk.com`: `cf_product_category` = **`Electric chopper`** (lowercase c)
> with SKUs `Trutrtl-Smart-Chopper-Black` / `Trutrtl-Smart-Chopper-Pink`, and `cf_custom_tags` gained
> **`Electric Chopper`** (capital C — a different field with a different casing convention; both are
> correct, see the lockstep box under Function 2). `src/lib/product-map.js` already reflects this —
> the chopper is out of `CATEGORY_UNAVAILABLE_PRODUCTS` and `RECOGNISED_ONLY_PRODUCTS` and is now a
> normal filable product. **The one place this hadn't landed is the enum below**, which is why it now
> reads `Electric Chopper` rather than the earlier stopgap tag `Chopper`.
>
> **Function 1's RESPONSE also moved (M-4 / M-5).** `formatStatus()` now returns `queue_spoken`,
> `closure_reason`, `registered_on`, `registered_phrase`, `service_partner_spoken`, `field_agent_ticket` and
> `sla_breached` on an identity-confirmed lookup, and rewrites `expected_next_step` on a breached SLA.
> The Returns section under Function 1 is now the full, source-verified list — Tara's Phase 6.5 depends
> on every one of them.

Replace the placeholders before saving:
- `<MIDDLEWARE_URL>` → **`https://trutrtl-support.digidzn.com`** (the DIGIDZN VPS deploy — see
  [`VPS_DEPLOY.md`](./VPS_DEPLOY.md)). The old Render host is retired; anything still pointing at
  `*.onrender.com` is pointing at nothing.
- `<RAVAN_SHARED_SECRET>` → the exact value you set in the middleware's `.env` on the VPS

All three point at the same deployed middleware. Status lookup is safe to enable immediately;
register is enabled per your decision (keep `TEST_AUTO_CLOSE=true` until you've watched a live test).

---

## Function 1 — `get_complaint_status`
**Type:** Custom Function → **Custom (Server-Side API)**
**Method:** `POST`
**URL:** `<MIDDLEWARE_URL>/freshdesk/complaint-status`
**Timeout:** `12000` ms — ⭐ **M-9/R-5, was 8000.** Only valid together with `FRESHDESK_TIMEOUT_MS=3500`
in the middleware env; see [Function timeouts](#function-timeouts--m-9--r-5) before changing either.
**Headers:**
| Key | Value |
|---|---|
| `Authorization` | `Bearer <RAVAN_SHARED_SECRET>` |
| `Content-Type` | `application/json` |

### ⚠ SEQUENCING — read this before wiring it into the prompt

> ⭐ **C1 UPDATE (2026-07-22, client-approved identity loosening).** The identity gate is now
> **path-dependent**. On the **by-phone** lookup (`phone_number`, no `complaint_number`), **phone +
> brand is sufficient identity** — the function returns the **full** case detail even when no name was
> sent or the stated name doesn't match, because the caller has already proven possession of the
> registered mobile and `isBrandTicket()` independently guarantees the ticket is truTRTL's. The strict
> gate below now applies **only to the by-COMPLAINT-NUMBER (by-ID) path**, where a guessed number could
> otherwise land on another same-brand customer's ticket; there the name check is **kept** but made
> **fuzzy and Unicode-aware** (so `वसीम`, `grus`/`gruz`, reversed order and honorifics all pass, while
> `Verma` vs `Sharma` still fails). Net effect: the empty-name early call that used to come back blank
> on the by-phone path **no longer does** — it returns the answer. Sending `caller_stated_name` when
> you have it is still good (it sets `name_matches` as a soft signal), just no longer required to hear
> a by-phone case.

This function runs an **identity gate on the by-ID path**: on a `complaint_number` lookup it will not
disclose status/product/latest-update unless you send `caller_stated_name` and it (fuzzily) matches the
ticket's registered requester. Tara's Phase 6 today calls this function at **6.3** (right after
confirming the complaint/phone number) and only asks for the caller's name at **6.4** — i.e. it calls
the tool **before it has a name**. On a **by-phone** lookup that ordering is now **fine** — the first
call returns the case. On a **by-ID** lookup, still send the name on (or before) that call, or call the
function again once you have it.

**Phase 6 must change to one of:**
1. Ask for the caller's name **before** calling the function, and send it as `caller_stated_name` on
   the one call, or
2. Keep the current order but call the function **a second time** once the name is collected at 6.4,
   this time with `caller_stated_name` set.

Option 2 is cheap: the middleware caches the **ticket**, not the formatted answer, for
`STATUS_CACHE_TTL_MS` (30s by default) — so the second call is a cache hit, not a second Freshdesk
read, and does not spend the account's shared ~40 req/min budget. Do not skip this — see
`BACKPORT_2026-07.md` for the full go-live checklist.

**Description (this is what makes Tara call it — keep it precise):**
> Call this whenever the customer asks for the status or update of an existing complaint or ticket.
> Pass `complaint_number` if they give one; otherwise pass their `phone_number`. **Always also pass
> `caller_stated_name` — the name the caller gave you in THIS call, exactly as they said it.** If you
> don't have their name yet, ask for it first, or call this function again once you do — you may call
> it twice for the same lookup. Tell the customer to hold for a moment before calling. **If the
> function returns `name_matches:false`, share nothing case-specific** — no product, no status, no
> update; offer a callback instead. Only report what this function returns — never invent a status.

**Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "complaint_number": { "type": "string", "description": "The complaint/ticket number the customer reads out to you. Send exactly the digits they said — never a number from an example, a previous call, or one that merely looks right." },
    "phone_number": { "type": "string", "description": "The customer's phone number as THEY said it, in +91XXXXXXXXXX or 10-digit form. Never invent or complete a number they did not say." },
    "caller_stated_name": { "type": "string", "description": "The name the caller gave in THIS call, exactly as they said it. Send it every time you have it — the server checks it against the ticket's registered name and returns name_matches. Do not read the registered name out loud to the caller; the server never sends it back." }
  },
  "required": []
}
```

✅ **R-0 verified against the deployed code** (`src/routes/complaint-status.js`): the parameter name
`caller_stated_name` is exactly what the route reads, `complaint_number` and `phone_number` are the two
identifiers, and a call with neither returns `missing_identifier` as documented below. (The route also
tolerates `callerStatedName` / `stated_name` if Ravan's UI mangles the key — but **save it as
`caller_stated_name`**; the aliases are a safety net, not a second contract.) The name comparison is
forgiving on purpose — first name only, reversed order and honorifics all pass; a contradicting token
("Priya Verma" against "Priya Sharma") does not.

**Returns** (Tara reads this aloud):

⭐ **M-4/M-5 ENRICHMENT — the response shape below is the CURRENT one, verified field-by-field against
`src/lib/ravan.js` `formatStatus()`.** It carries **seven fields the pre-M-4 version of this file never
declared** — `queue_spoken`, `closure_reason`, `registered_on`, `registered_phrase`, `service_partner_spoken`,
`field_agent_ticket`, `sla_breached` — **and rewrites an eighth**, `expected_next_step`, when the SLA is
blown. Tara's prompt Phase 6.5 already branches on them (closure outcome first, then the date and age
"as the system gives them to you", then the overdue acknowledgement). A field this file does not declare
is a field the operator does not know to expect, which is precisely the lockstep failure
[`BACKPORT_2026-07.md`](./BACKPORT_2026-07.md) exists to prevent.

Identity confirmed, **open case** — the optional fields appear only when that ticket actually has them:
```json
{ "found": true, "complaint_number": "11914", "name_matches": true, "product": "Ceiling Fan",
  "status_label": "in progress", "days_since_registered": 4,
  "expected_next_step": "The service team is working on it; you should hear about a technician visit shortly.",
  "latest_update": "Dear Customer, a technician visit is being scheduled…",
  "queue_spoken": "it is with a technician now",
  "registered_on": "18 June 2026", "registered_phrase": "4 days ago",
  "service_partner_spoken": "with our authorised service partner", "field_agent_ticket": "FA-88213" }
```
Identity confirmed, **closed case** — `closure_reason` appears here and only here (status 4 or 5):
```json
{ "found": true, "complaint_number": "11914", "name_matches": true, "product": "Kettle",
  "status_label": "completed and closed", "days_since_registered": 9,
  "expected_next_step": "This complaint is completed and closed.",
  "closure_reason": "a replacement was dispatched to you",
  "queue_spoken": "a replacement has been dispatched to you",
  "registered_on": "9 June 2026", "registered_phrase": "9 days ago" }
```
Identity confirmed, **open and past the SLA** — `sla_breached` appears only when `true`, and
`expected_next_step` has **already been replaced** with the escalation line:
```json
{ "found": true, "complaint_number": "11914", "name_matches": true, "product": "Ceiling Fan",
  "status_label": "registered and open", "days_since_registered": 32, "sla_breached": true,
  "expected_next_step": "This has taken longer than it should have. I can put you through to a colleague now, or log a callback so a senior team member takes this up today.",
  "queue_spoken": "we have not been able to arrange a technician in your area yet",
  "registered_on": "16 May 2026", "registered_phrase": "32 days ago" }
```

**Every field, and what Tara does with it:**

| Field | Always? | What it is | Spoken? |
|---|---|---|---|
| `found` | yes | `true` — a truTRTL ticket was resolved and passed the brand filter. | no — it's a branch |
| `complaint_number` | yes | The Freshdesk ticket id as a string. | digit by digit |
| `name_matches` | yes | The name-check boolean. ⭐ **C1:** on the **by-phone** path it is now a **soft signal only** — the case detail is returned regardless of its value (phone + brand is the identity). On the **by-ID** (`complaint_number`) path it is still a hard gate: `false` there ⇒ every field below is **absent by construction**. | no — it's a branch |
| `status_label` | after gate | One of `registered and open` / `in progress` / `resolved` / `completed and closed`, or `being processed` for an unknown status int. | yes, verbatim |
| `days_since_registered` | after gate (`null` if the timestamp is unreadable) | Whole calendar days in Asia/Kolkata (same day = `0`). **An integer — for `sla_breached` to be computed server-side, not for Tara to speak.** Say `registered_phrase` instead. | ❌ no |
| `expected_next_step` | after gate | The safe generic next-step line for the status — **replaced outright** by the SLA line when `sla_breached` is set. | yes, verbatim |
| `registered_on` | when parseable | ⭐ The registration date **already rendered for speech**: `"18 June 2026"` (day, month in words, year — no ordinal suffix, TTS-safe). Absent only when the timestamp is missing or unparseable — never a guessed date. | yes, verbatim |
| `registered_phrase` | after gate | ⭐ The age **already rendered for speech**: `today` / `yesterday` / `"32 days ago"`, or `recently` when the date could not be read. | yes, verbatim |
| `product` | when set | The product from `cf_custom_tags`, falling back to `cf_product_category`. | yes |
| `latest_update` | when a safe note exists | The newest **customer-facing** note only (a public reply, or a private note addressed "Dear Customer…"), trimmed to one sentence. Internal shorthand is deliberately withheld — absent means there is nothing sayable, not that nothing happened. | yes |
| `queue_spoken` | when the queue has a client-supplied meaning | ⭐ Where the case **is**, in customer words — e.g. *"it is with a technician now"*, *"a replacement has been dispatched to you"*, *"we have not been able to arrange a technician in your area yet"*. **This is the only sayable form of the queue.** Absent for a queue whose meaning the client never gave us (Warranty, with Factory) or one we don't recognise at all — then say the status label and offer a callback. | yes, verbatim |
| `closure_reason` | status 4/5 only, when determinable | ⭐ **Why it closed**, normalised — *"a replacement was dispatched to you"*, *"we closed it after we couldn't reach you for about fifteen days"*, *"we couldn't arrange a technician in your area"*, *"the product was reported working again"*. Never the raw note. Prompt 6.5 leads with this **before** saying it's closed; absent ⇒ say honestly that the reason isn't visible and offer a callback. | yes, verbatim |
| `service_partner_spoken` | when a partner holds it | ⭐ That a service partner holds the unit, **in customer words** — *"with our authorised service partner"*. Like `queue_spoken`, this is the **only** form that crosses the wire: the raw dropdown values (`Rapid Era`, `On SIte Go` — that typo is real on the desk — and `Others`) are internal ops vocabulary and never reach the agent. Omitted when the dropdown reads `No` (its explicit "not sent to a partner" value), so its presence always means a partner really has it. | yes, verbatim |
| `field_agent_ticket` | when set | ⭐ The field-agent ticket number (`cf_field_agent_ticket_number`) — the ops-side reference for the visit. | only if the caller asks; digit by digit |
| `sla_breached` | only when `true` | ⭐ The overdue flag: an **open** case (status 2 or 3) older than **7 days**. Never present on a closed case, and never `false` — absent means not breached. When it is set, `expected_next_step` has already been replaced with the acknowledge-and-escalate line, so Tara cannot quote "2 to 3 working days" at someone who has waited a month. | the flag itself, no — act on it (prompt 6.5) |

⛔ **`registered_on` and `registered_phrase` are PRE-RENDERED. Tara reads them; she never recomputes
them.** That is the entire point of M-4 / defect 17 (*"complaint registered date nahi bata pati hai"*):
the response used to hand her the integer `days_since_registered` and nothing else time-related, so
answering *"when did I register this?"* meant doing calendar arithmetic mid-call from "32" — which she
cannot reliably do and must never be asked to. Both strings are already rendered in **Asia/Kolkata**, so
they match the customer's calendar rather than the server's. Never derive a date from
`days_since_registered`, never convert days into months, and never say the integer itself.

⛔ **No raw ops vocabulary is in this response and none is sayable.** The queue's raw dropdown text
(`WITH DIGICART`, `No Tech Found`, `Courier`) is ops shorthand for the log line, not customer language —
`queue_spoken` is the only form that reaches a call. Same for the status integer, the group id and the
`cf_*` field names: they are plumbing, and none of them is ever read aloud. (See §*Machine values Tara
never says aloud*.)

Ticket exists on a **by-COMPLAINT-NUMBER lookup**, but the stated name doesn't (fuzzily) match, or no
name was sent — **nothing case-specific, by design**. ⭐ **C1: this shape is now the by-ID path only.**
On a **by-phone** lookup the same ticket returns its **full** case detail (phone + brand is sufficient
identity), so a `name_matches:false` there does **not** suppress anything:
```json
{ "found": true, "complaint_number": "11914", "name_matches": false }
```
Nothing matches — **or the ticket belongs to another brand on the shared desk (MILTON/APARNA/FKSB).**
Both cases are answered identically on purpose; Tara must never be able to tell a genuine miss from
someone else's ticket:
```json
{ "found": false }
```
Neither `complaint_number` nor `phone_number` was sent:
```json
{ "found": false, "error": true, "reason": "missing_identifier",
  "spoken_hint": "Could you give me your complaint number, or the mobile number your complaint is registered with?" }
```
⛔ `missing_identifier` is a **machine value — Tara says the `spoken_hint`, never the code**
(§[Machine values Tara never says aloud](#machine-values-tara-never-says-aloud)).

The real requester name is **never** returned in any shape above — only the `name_matches` boolean.

---

## Function 2 — `register_complaint`

> ⛔⛔ **DO NOT TURN THIS DESCRIPTION BACK INTO A CHECKLIST — READ THIS FIRST (guard-rail, hard-won
> 2026-07-22).** The `register_complaint` **Description** below MUST stay a **short, positive trigger**
> — a plain statement of what the tool does and when to call it. A description stuffed with
> preconditions ("Call this **ONLY** after…", "read them **ALL** back", "confirmed", "**NEVER** reuse",
> "never substitute…") **suppressed the tool call entirely for days** — Tara silently stopped firing
> `register_complaint` at all. Making it a clean trigger is what **finally makes the tool fire**.
> **Do not add `ONLY`, checklists, read-back gates, or `NEVER`/`never` negatives back into this
> Description (or into Function 1's).** Every bit of "collect the fields first, read the phone back
> digit by digit, get an explicit yes, never fabricate a value" discipline is real and required — but
> it lives in **Tara's SYSTEM PROMPT (§12 HARD RULES / Phase 5–6)**, never here. This note exists so a
> future well-meaning edit doesn't re-break intake by "helpfully" moving that discipline into the tool
> description.

**Type:** Custom Function → **Custom (Server-Side API)**
**Method:** `POST`
**URL:** `<MIDDLEWARE_URL>/freshdesk/register-complaint`
**Timeout:** `12000` ms — ⭐ **M-9/R-5, was 8000.** Only valid together with `FRESHDESK_TIMEOUT_MS=3500`
in the middleware env; see [Function timeouts](#function-timeouts--m-9--r-5) before changing either.
**Headers:** same Authorization + Content-Type as above.

**Description** — ⛔ keep this a short positive trigger; see the guard-rail note at the top of this
section. All "collect first / read the phone back / never fabricate" discipline lives in the SYSTEM
PROMPT, not here:
> File a new warranty complaint for a customer's faulty product. Call this once you have the customer's
> name, phone number, product, platform (where they bought it), and the issue. It returns a complaint
> number for the customer. Send `model` when the customer names their size or variant, and `caller_id`
> — the number the call came in from — when the telephony gives it to you.

**Parameters (JSON Schema)** — ⭐ **R-4: `model` and `caller_id` are new, and the `product` enum gains
`Electric Chopper`** — the real, live `cf_custom_tags` value, confirmed 2026-07-18 now that F-2 is
done (see the box below). The other ten `product` values and all ten `platform` values are unchanged
and still match Freshdesk's dropdowns **exactly** — do not retype them:
```json
{
  "type": "object",
  "properties": {
    "name":            { "type": "string", "description": "Customer's full name" },
    "phone_number":    { "type": "string", "description": "Phone in +91XXXXXXXXXX or 10-digit form" },
    "caller_id":       { "type": "string", "description": "The number this call actually came in FROM (telephony ANI), if the platform gives it to you. Send it whenever you have it, even when it matches what the customer said. Never read it back to the caller and never use it in place of the number they gave you." },
    "product":         { "type": "string", "enum": ["Ceiling Fan","Kettle","Egg boiler","Air fryer","Sandwich Maker","Mixer Grinder","Induction","Cooker","Gas Stove","Iron","Electric Chopper"], "description": "Product category" },
    "model":           { "type": "string", "description": "The size/variant the customer names, as a SHORT token: 1.3, 1.5, digital, manual, 12L, 14egg, 7egg, 3-in-1, grill, toast, smart, wave, ultra, 3jar, 2jar, 3B. Leave it out entirely if they don't know — a wrong token is worse than none. (optional)" },
    "platform":        { "type": "string", "enum": ["Amazon","Flipkart","Website","Zepto","Blinkit","Myntra","CRED","JioMart","BigBasket","Swiggy"], "description": "Where it was purchased" },
    "issue_description":{ "type": "string", "description": "What's wrong with the product" },
    "purchase_date":   { "type": "string", "description": "When they bought it — ISO YYYY-MM-DD if they have the invoice, otherwise their own words ('26 May', 'two months ago'). The server resolves them against the call date. (optional)" },
    "order_id":        { "type": "string", "description": "Marketplace order ID from the invoice (optional)" },
    "installed":       { "type": "boolean", "description": "Is the product installed? (optional, mainly for fans)" },
    "pincode":         { "type": "string", "description": "6-digit area pincode (optional)" },
    "city":            { "type": "string", "description": "City (optional)" },
    "state":           { "type": "string", "description": "State (optional)" }
  },
  "required": ["name", "phone_number", "product", "platform", "issue_description"]
}
```

> ⭐ **C6 — the `platform` enum (2026-07-22 client reversal).** `Meesho` and `Jabong` are **deliberately
> absent** from the `platform` enum above: the client confirmed truTRTL is **not active** on those
> channels, reversing the earlier **F-5** request that had asked for them to be *added*. The enum already
> omitted them, so **no enum edit is needed here** — the point is that they stay out. The middleware
> still **recognises** both (they sit in `UNMAPPED_CHANNELS`) so a legacy buyer who names one is honestly
> declined via `unmapped_channel` (see the failure table below) rather than misfiled as `Website`, and
> the desk admin is separately **removing both from the `cf_purchased_from` dropdown** — see
> [`REQUEST_freshdesk-admin-meesho-jabong.md`](../REQUEST_freshdesk-admin-meesho-jabong.md). Tara must
> also stop naming them as available channels (prompt speech-guard, C6).

### ⛔ WHY THE ENUM STRING MATTERS — AND WHAT IT MUST BE NOW THAT F-1/F-2/M-12 ARE DONE

**Historical context, kept because it explains why the code and the enum had to move together.** A
JSON-schema `enum` is a hard constraint on the model — Tara **cannot** emit a `product` value that
isn't listed. While the desk had no chopper node and the enum had no chopper value at all, she was
**forced** to pick the nearest legal one, `Mixer Grinder`. That mapped cleanly to
`Trutrtl-Nutri-Insta-2Jar`, Freshdesk accepted it, and she read back a real number for a confident,
valid, **completely wrong** ticket that ops dispatched a technician from. Shipping the middleware fix
alone (**M-1**, the original stopgap, which taught `product-map.js` to recognise the word "chopper" in
free text) could not close that gap by itself — the middleware never got a chance to refuse anything,
because the fabricated ticket was already created before Tara's spoken words ever reached it. **The
missing enum value was the actual point of failure, not the missing code:**

| Enum | Code | What a chopper call did |
|---|---|---|
| no chopper value | pre-`M-1` | **The live defect.** Fabricated `Mixer Grinder` / `Trutrtl-Nutri-Insta-2Jar` ticket, a real number read back, a technician dispatched to the wrong product. |
| no chopper value | `M-1` stopgap shipped | **Still broken.** `M-1` recognised the *word* "chopper" in free text, but never saw it — Tara's only legal enum choice was still `Mixer Grinder`. |
| `Chopper` (stopgap tag, not a real dropdown value) | `M-1` stopgap shipped | Honest refusal — `category_unavailable`, terminal, `logUnfiled()` captured the caller for a manual callback. No fabricated ticket, but also **no chopper could be filed at all**, because the desk had no node for one (that was F-1). |

**F-1 and F-2 are now DONE (verified live 2026-07-18).** The desk admin added the node:
`cf_product_category` = `Electric chopper` (lowercase c) with SKUs `Trutrtl-Smart-Chopper-Black` /
`Trutrtl-Smart-Chopper-Pink`, and `cf_custom_tags` gained `Electric Chopper` (capital C — this
dropdown's own singular convention, and a **different string in a different field** from the category
value — do not copy one into the other). **M-12 has already been applied in
`src/lib/product-map.js`** — verified directly in source: the chopper is gone from both
`RECOGNISED_ONLY_PRODUCTS` and `CATEGORY_UNAVAILABLE_PRODUCTS`; `FRESHDESK_PRODUCT_TAGS` now carries
`'Electric Chopper'`; `TRUTRTL_CATEGORIES` carries `'Electric chopper'` with its two SKUs and a
`DEFAULT_SKU` entry (`Trutrtl-Smart-Chopper-Black`); and both `RULES` and `CATEGORY_RULES` map
`/\bchopper\b/i` to the right value **above** the mixer/grinder/juicer/blender rule — the same
first-match-wins ordering that used to be the trap is now what protects the correct outcome, because
`mapCategory('chopper grinder')` still answers `Mixer Grinder` if that ordering is ever disturbed.

**So today, with F-1/F-2/M-12 all done, the enum above must carry `Electric Chopper` — not the old
stopgap tag `Chopper` — so `mapProduct()` exact-matches it straight onto the real `cf_custom_tags`
value**, the same way the other ten enum values are exact matches to their dropdown rather than free
text this function happens to parse. ⚠ Worth knowing, not relying on: `mapProduct()` also falls back to
the same `/\bchopper\b/i` rule on unmatched free text, so the old bare `Chopper` string would still
resolve correctly even today — it just does it as a regex rescue rather than a direct dropdown match.
Use the exact string in the enum anyway; the fallback exists for what a caller *says*, not as a
substitute for the enum being right.

**No ticket is fabricated and no refusal happens for a chopper call today.** `Toaster` and
`Water Boiler` remain deliberately **not** in the enum — unlike the chopper, those two are still
genuinely unmapped (an unanswered `[CONFIRM]`, not a missing Freshdesk node) and reach the middleware
only as free text (**M-6**). The chopper has left that category entirely: it is now a normal, filable,
dropdown-backed product like any of the other ten.

### `model` — send a SHORT token or nothing at all

`model` closes the dead-parameter defect (defect 12): the middleware has always passed it to
`mapSku(category, model)`, but Tara had no such field, so **every** ticket took the category's default
SKU — every fan `Trutrtl-Smart-1200 MM`, every kettle `Electric-1.5 Kettle`, every air fryer
`Manual(KZ-4505 M)`.

⚠ **A model string that doesn't match is worse than sending none.** `mapSku()` does a two-way substring
test against the SKU list and falls back to the default when nothing hits — and `fieldFallbacks()` only
prints the *"⚠ Model not identified on the call"* warning when **no** model was sent. So an unmatched
token files a defaulted SKU **with the warning suppressed**: ops sees a model that looks confirmed.
Verified by running the real mapper:

| Caller says | Send | Resolves to | Sending the phrase instead |
|---|---|---|---|
| 1.3 litre kettle | `1.3` | `Multipurpose-1.3Kettle` | `1.3 litre` → **`Electric-1.5 Kettle`** (wrong, silent) |
| 1.5 litre kettle | `1.5` | `Electric-1.5 Kettle` | — |
| digital / manual air fryer | `digital` / `manual` | `Digital(KZ-4505 A1)` / `Manual(KZ-4505 M)` | — |
| 12 L air fryer oven | `12L` | `Trutrtl-Airfryer-12L` | `12 litre` → **`Manual(KZ-4505 M)`** (wrong, silent) |
| 14-egg boiler | `14egg` | `14Egg Plastic - Black` | `14 egg` → **`7Egg Plastic - White`** (wrong, silent) |
| 3-in-1 sandwich maker | `3-in-1` | `3-in-1 Sandwich Maker` | `3 in 1` → **`Grill-Sandwich Maker`** (wrong, silent) |
| 3-jar mixer | `3jar` | `Trutrtl-Nutri-Insta-3Jar` | `3 jar` → **`Trutrtl-Nutri-Insta-2Jar`** (wrong, silent) |
| 3-burner gas stove | `3B` | `Shakti 3B` | `3 burner` → **`Shakti 2B`** (wrong, silent) |

If the caller doesn't know, **omit the parameter** — the ticket then carries the honest
*"Model not identified on the call — confirm from the invoice"* line, and Tara says so out loud
(prompt item **P-8**).

### `caller_id` — never a refusal, always a note

`caller_id` is the telephony ANI. The middleware compares its last ten digits with the number the
caller *stated*; a disagreement is **not** a rejection — people legitimately call from a landline, an
office line or a spouse's phone, and the number they want to be reached on is the one they said. The
ticket is filed against the **stated** number, and both numbers land on it twice: a `⚠ Numbers disagree`
line at the top of the description and a private note reading *"Caller stated a different number from
the one they called from — verify"*. Ops decides. When registration is **refused**, the ANI is written
to the unfiled log too — on the paths where the stated number was misheard it is the only working way
back to that customer. Nothing about `caller_id` is ever read aloud.

**Returns on success:** `{ "complaint_number": "11916" }`.

**Returns on failure — HONEST, not silent.** If the complaint cannot be filed *correctly*, the
middleware creates **nothing** and returns a stable `reason` plus a `spoken_hint` that is safe to say
verbatim on a live, recorded call. **A failure response never contains a `complaint_number`** — Tara
must never read out a number she didn't receive.

| `reason` | What triggers it | Tara's move |
|---|---|---|
| `missing_required` | One of `name`, `phone_number`, `product`, `platform`, `issue_description` is empty. Comes with a `missing` array naming those fields, e.g. `{"reason":"missing_required","missing":["issue_description","phone_number"],"spoken_hint":"I just need a couple more details before I can file this for you."}`. ⛔ The array is **machine input** — Tara reads it to know what to re-ask, and never says a field name aloud. | **Recoverable** — ask for the missing field(s) in the caller's own words ("what exactly is happening with it?", not "issue underscore description"), one question per turn, then call again. |
| `invalid_phone` | ⭐ **M-2, new.** `phone_number` is not a valid Indian mobile: fewer than ten digits, or a ten-digit subscriber number that doesn't start 6–9. (`+91`, `91`, spaces and dashes are all fine — the last ten digits are what's checked.) Runs **first, before the product/platform gate and before any write**. | **Recoverable** — say the `spoken_hint` verbatim (*"Let me just take that number again — could you say it digit by digit?"*), take the number again, then call again. |
| `unmapped_product` | The product text doesn't match any of the 10 `cf_custom_tags` choices and isn't a recognised-but-unavailable product. | **Recoverable** — ask which product it is, then call again. |
| `category_unavailable` | The product **is** a real truTRTL product — but it has **no node in the Brand→Category→SKU tree**, so Freshdesk would reject the create. **Five** products hit this today: `Induction`, `Cooker`, `Iron` (in the enum and in `cf_custom_tags`) and `Toaster`, `Water Boiler` (recognised from the caller's words, not dropdown values). ⭐ `Chopper` **left this list 2026-07-18** — F-1/F-2 gave it a real node (`Electric chopper` category / `Electric Chopper` tag) and M-12 mapped it in code, so the brand tree is now **8** categories (was 7) and a chopper is a normal filable product, not a terminal one. | **Terminal** — take a callback. Never file it as a Ceiling Fan or a Mixer Grinder to get a number out. |
| `unmapped_platform` | The platform text doesn't match the `cf_purchased_from` dropdown and isn't a recognised-but-unmapped channel. There is no "Other" option on this dropdown. | **Recoverable** — ask where they bought it, then call again. |
| `unmapped_channel` | The platform is a channel the middleware **recognises by name** but has **no value for** on `cf_purchased_from`. ⭐ **C6 (2026-07-22 client reversal):** `Meesho` and `Jabong` are the two channels here — the client confirmed truTRTL is **not active** on them, reversing the 2026-07-20 F-5 addition that had briefly made them filable. They are kept recognised (restored to `UNMAPPED_CHANNELS`) **only** so a legacy buyer who names one is **honestly declined and called back**, never silently misfiled — and they remain **absent from the `platform` enum**, so Tara can't offer them. | **Terminal** — take a callback. Never file it as `Website`; that silently changes which return policy applies and which invoice gets asked for. |
| `freshdesk_error` | Anything else — Freshdesk rejected or timed out on the actual create. | **Terminal** — take a callback. |

For `category_unavailable` and `unmapped_channel`, everything the caller gave you (name, callback
number, product/platform as stated, issue, location) is captured in the middleware's log so ops can
file it by hand and call the customer back — but **Tara never sees a ticket number for these**, because
none was created.

`invalid_phone` is deliberately **recoverable**, not terminal: a misheard number is the one failure a
single re-ask reliably fixes, and taking a callback on a number we already know is unreachable would be
theatre. The `spoken_hint` never tells the caller their number is wrong and never says Tara misheard —
on a recorded line the caller must not be blamed for what the ASR did, and asking for it digit by digit
fixes both causes. (Defect 2: this route previously checked only that the field was non-empty, then
filed the last ten digits of whatever it had heard — so the callback, the document-request WhatsApp,
the invoice and the video all went to a stranger.)

The middleware accepts free-text product/platform too (e.g. "1.5L kettle", "bought on Zepto") and maps
it to the right dropdown, but the enums above keep Tara consistent. On success it also **auto-fills the
fields Freshdesk requires on create** (brand=truTRTL, the nested product-category + SKU, group, GROUP
CUSTOM, and placeholders `NA`/`0` for any order-id/pincode/city/state the caller didn't give) — so Tara
never has to ask for everything; ops reconciles the rest from the WhatsApp invoice. **The purchase date
is no longer one of those placeholders** (M-7): the caller's own words are resolved against the call
date in Asia/Kolkata, and when nothing resolves the field carries an unmistakable *not captured*
sentinel — never today's date, which is what used to make a two-year-old fan look bought this morning
on the one field warranty is assessed from.

---

## Machine values Tara never says aloud

Both functions return values that exist **for the agent's logic and for the ops log — not for the
caller's ear.** Nothing in this contract is safe to read out just because it arrived in the response.
The rule is one line: **branch on the machine value, speak the plain-English one.**

| Never spoken | Where it comes from | What Tara says instead |
|---|---|---|
| `reason` codes — `missing_required`, `invalid_phone`, `unmapped_product`, `category_unavailable`, `unmapped_platform`, `unmapped_channel`, `freshdesk_error` (register), `missing_identifier` (status) | `src/routes/register-complaint.js` `SPOKEN` / `fail()`; `src/routes/complaint-status.js` `missingIdentifier()` | The **`spoken_hint`** that ships with it. It is written to be safe verbatim on a live recorded call — no jargon, no blame, no invented commitments. |
| The `missing` array — `["name","phone_number","product","platform","issue_description"]` in any combination | `missing_required` responses only | Nothing. Use it to decide **which question to ask next**, in the caller's own words, one per turn. Never spell a field name. |
| Raw queue / group vocabulary — `WITH DIGICART`, `No Tech Found`, `Courier`, `with 247`, a numeric group id | the desk's `cf_group_custom` and Freshdesk groups | **`queue_spoken`** — the client's own meaning in customer words. No `queue_spoken` ⇒ say the status label and offer a callback. |
| The Freshdesk **status integer** (`2`,`3`,`4`,`5`), `cf_*` field names, SKU strings, `name_matches`, `found`, `sla_breached`, `days_since_registered` | the wire response | `status_label`, `closure_reason`, `expected_next_step`, `registered_on` + `registered_phrase` — the fields that were rendered for speech on purpose. |
| `caller_id` (the telephony ANI) | Function 2 input | Nothing, ever — see §*`caller_id` — never a refusal, always a note*. |
| The ticket's registered requester name | never returned at all | Nothing. The caller states the name; Tara never offers one (prompt Contract rule 3). |

A `spoken_hint` is always present on an error response, so there is never a case where saying the code
is the only option. If a hint is somehow missing, Tara falls back to the honest generic — *"I'm not able
to log this one from here — let me take your details and have the team call you back"* — and **never**
recites the code, the field name, the queue name or the status number.

This is mirrored in Tara's system prompt §12 (HARD RULES) so the two artifacts cannot drift apart.

---

## Function timeouts — M-9 / R-5

Both functions above move from `8000` ms to **`12000` ms**, and that raise is only half the fix. It
**must** be saved together with a **lowered** `FRESHDESK_TIMEOUT_MS` in the middleware env:

```
FRESHDESK_TIMEOUT_MS=3500     # was 5000 — lower it in the SAME change as the 12000 ms function timeout
FRESHDESK_MAX_RETRIES=1       # unchanged: 1 retry = 2 attempts total
```

**Why both, and why in that direction.** `src/lib/freshdesk.js` runs `1 + FRESHDESK_MAX_RETRIES`
attempts, each with its own `FRESHDESK_TIMEOUT_MS` abort, plus a short backoff between them (200 ms on
a network error, up to 2000 ms honouring `Retry-After` on a 429/5xx):

- **Today:** 5000 + 2000 + 5000 ≈ **12 s worst case** against an **8 s** function timeout. Ravan gives
  up *during the second attempt* — so the caller hears up to eight seconds of nothing (Core Rule A
  forbids filler, defect 11: *"chup ho jati hai"*) and Tara is handed a generic tool failure, which is
  exactly the moment she is most likely to improvise. Worse on `register_complaint`: Freshdesk may
  still create the ticket after Ravan has stopped listening, so the complaint exists and nobody read
  its number out.
- **After M-9:** 3500 + 2000 + 3500 ≈ **9 s worst case** inside a **12 s** window. **Both retries now
  fit**, and the function returns a real answer — success or an honest `reason` — rather than being cut
  off mid-write.

Raising the function timeout **without** lowering `FRESHDESK_TIMEOUT_MS` only lengthens the silence;
lowering `FRESHDESK_TIMEOUT_MS` **without** raising the function timeout makes a slow-but-healthy
Freshdesk fail faster than it needs to. Neither half is useful alone.

Pair this with prompt item **P-3** (Rule A gains a filler exception: Tara says she's checking, and says
it again past ~4 s) — a 12 s window that the caller spends in silence is not an improvement on an 8 s
one.

⚠ **Not yet set anywhere.** `FRESHDESK_TIMEOUT_MS` still reads `5000` in `.env.example` and defaults to
`5000` in `src/lib/config.js`, so raising these two function timeouts on its own leaves the pairing
*worse* than before — a 12 s window in front of a ~12 s worst case. Put `FRESHDESK_TIMEOUT_MS=3500` in
the VPS `.env` (`docker compose up -d` re-reads it — no rebuild, see
[`VPS_DEPLOY.md`](./VPS_DEPLOY.md)) and update `.env.example` in the same change, so a fresh clone
cannot reintroduce the pairing this fixes.

---

## After-Call Webhook
Agent settings → **Webhook / After-Call Webhook**:
- **URL:** `<MIDDLEWARE_URL>/ravan/after-call?key=<RAVAN_SHARED_SECRET>` — **the `?key=` is now
  REQUIRED, not optional.**
- **Method:** `POST`
- **Enabled:** yes
- No auth header needed — the key rides in the query string.

### ⚠ GO-LIVE CHECK — do this before flipping the switch
The middleware used to accept a keyless request as if it were authorised (the guard only fired when
`?key` was *present*). That hole is closed: **the key must now be present AND match, or the request
gets a `401`** — no note, no ticket. **If Ravan's UI cannot append a query string to this webhook URL,
the after-call webhook WILL start failing with 401 on every call the moment this code is deployed.**
Confirm you can save the URL with `?key=...` attached before deploying, and verify after configuring:
a POST with the correct key returns `200 {ok:true}`; the same POST without `?key=` (or with the wrong
value) must return `401`.

Every completed call then logs a private summary note onto the caller's existing truTRTL ticket. If
they have none, a ticket is created **only when Ravan states a product and platform the middleware can
file truthfully** — otherwise the call is logged and nothing is written, because the old behaviour here
was to let the `|| 'Ceiling Fans'` fallback fire and stamp every after-call ticket with a product the
caller never mentioned.

⚠ **Read that together with a refused registration.** When Tara declines an Induction, Cooker, Iron,
Meesho or Jabong call, no ticket exists — and this webhook will not create one either, because those
products/channels still cannot be filed and a platform is rarely stated. (A chopper is **no longer** on
this list — F-1/F-2/M-12 made it filable on 2026-07-18.) For a first-time caller the
**`logUnfiled()` WARN in the service log is the only record the complaint ever happened.** That makes
log retention on the VPS load-bearing, not housekeeping: if the logs roll or the container is replaced
before ops reads them, the customer is simply gone. (Owner decision pending: give the terminal reasons
a real sink — an ops queue or an "Unfiled" ticket — rather than a log line.)

The middleware always replies `200 {ok:true}` for an
authorised request so Ravan won't retry-storm — `401` is the one deliberate exception, because a
misconfigured URL should fail loudly, not silently write into a shared production helpdesk under the
wrong assumption that it's protected. **Heads-up:** Ravan's exact after-call payload isn't publicly
documented — the parser is defensive, but confirm the first real webhook in the logs and tell me if a
field is missing.

---

## Flags in Tara's system prompt

> ⚠ **CORRECTED 2026-07-18 — these three flags DO NOT EXIST.** Verified by reading
> `truTRTL_Inbound_Voice_Agent_System_Prompt.md` (v2.0) directly: the only placeholders in the whole
> prompt are `{{current_time_Asia/Kolkata}}` (line 1) and `{{customer_name}}` (lines 96 and 208).
> `{{can_lookup_status}}`, `{{can_register_complaint}}` and `{{company_whatsapp}}` appear **nowhere**.
>
> This matters: the old text below told you to set a kill switch that isn't wired to anything.
> **There is no soft "off" for registration** — it goes live the moment Function 2's URL is pasted
> into the Agent Builder, and it writes real tickets to a live helpdesk shared with three other brands.

**What actually controls each thing:**

| What you wanted | The real control |
|---|---|
| Status lookup off/on | Whether Function 1 exists in the Agent Builder. There is no prompt flag. |
| Registration off/on | Whether Function 2 exists in the Agent Builder. **Delete/disable the function to disable it.** |
| Safe live registration test | `TEST_AUTO_CLOSE=true` in the middleware env — tags each ticket `voice_agent_test` and closes it immediately. Set `false` for production. |
| The WhatsApp number Tara refers to | `COMPANY_WHATSAPP` in the middleware env (`+91 95991 11390`), used in the ticket note and the WhatsApp send — **not** a prompt variable. The prompt hardcodes the number in its own copy. |

**If you want real kill switches**, they have to be added to the prompt as literal placeholders first,
and Ravan must be configured to inject them — otherwise `{{can_register_complaint}}` is just text the
model reads as a stray token. Until then, treat "function exists = feature is live."
