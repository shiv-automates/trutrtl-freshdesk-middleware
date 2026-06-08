# Ravan / Agni — Custom Function configs (paste into the Agent Builder)

Replace the placeholders before saving:
- `<MIDDLEWARE_URL>` → your deployed base URL, e.g. `https://trutrtl-freshdesk-middleware.onrender.com`
- `<RAVAN_SHARED_SECRET>` → the exact value you set in the middleware's `.env` (and Render env)

All three point at the same deployed middleware. Status lookup is safe to enable immediately;
register is enabled per your decision (keep `TEST_AUTO_CLOSE=true` until you've watched a live test).

---

## Function 1 — `get_complaint_status`
**Type:** Custom Function → **Custom (Server-Side API)**
**Method:** `POST`
**URL:** `<MIDDLEWARE_URL>/freshdesk/complaint-status`
**Timeout:** `8000` ms
**Headers:**
| Key | Value |
|---|---|
| `Authorization` | `Bearer <RAVAN_SHARED_SECRET>` |
| `Content-Type` | `application/json` |

**Description (this is what makes Tara call it — keep it precise):**
> Call this whenever the customer asks for the status or update of an existing complaint or ticket.
> Pass `complaint_number` if they give one; otherwise pass their `phone_number`. Tell the customer to
> hold for a moment before calling. Only report what this function returns — never invent a status.

**Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "complaint_number": { "type": "string", "description": "The complaint/ticket number if the customer gives one, e.g. 11914" },
    "phone_number": { "type": "string", "description": "The customer's phone number, used if no complaint number is given, e.g. +919876543210" }
  },
  "required": []
}
```

**Returns** (Tara reads this aloud):
```json
{ "found": true, "complaint_number": "11914", "product": "Ceiling Fan",
  "status_label": "in progress", "days_since_registered": 4,
  "latest_update": "Dear Customer, a technician visit is being scheduled…",
  "expected_next_step": "The service team is working on it…" }
```
or `{ "found": false }` when nothing matches.

---

## Function 2 — `register_complaint`
**Type:** Custom Function → **Custom (Server-Side API)**
**Method:** `POST`
**URL:** `<MIDDLEWARE_URL>/freshdesk/register-complaint`
**Timeout:** `8000` ms
**Headers:** same Authorization + Content-Type as above.

**Description:**
> Call this ONLY after you have collected — fresh in THIS call — the customer's name, phone, product,
> platform, and the issue, read them ALL back, and the customer confirmed they're correct. NEVER reuse
> details from a previous complaint or lookup. It returns a complaint number — read it back digit by
> digit. (The system then automatically WhatsApps the customer exactly what to send.)

**Parameters (JSON Schema)** — note the `enum`s match Freshdesk's dropdowns **exactly**:
```json
{
  "type": "object",
  "properties": {
    "name":            { "type": "string", "description": "Customer's full name" },
    "phone_number":    { "type": "string", "description": "Phone in +91XXXXXXXXXX or 10-digit form" },
    "product":         { "type": "string", "enum": ["Ceiling Fan","Kettle","Egg boiler","Air fryer","Sandwich Maker","Mixer Grinder","Induction","Cooker","Gas Stove","Iron"], "description": "Product category" },
    "platform":        { "type": "string", "enum": ["Amazon","Flipkart","Website","Zepto","Blinkit","Myntra","CRED","JioMart","BigBasket","Swiggy"], "description": "Where it was purchased" },
    "issue_description":{ "type": "string", "description": "What's wrong with the product" },
    "purchase_date":   { "type": "string", "description": "Purchase/order date as YYYY-MM-DD (optional)" },
    "order_id":        { "type": "string", "description": "Marketplace order ID from the invoice (optional)" },
    "installed":       { "type": "boolean", "description": "Is the product installed? (optional, mainly for fans)" },
    "pincode":         { "type": "string", "description": "6-digit area pincode (optional)" },
    "city":            { "type": "string", "description": "City (optional)" },
    "state":           { "type": "string", "description": "State (optional)" }
  },
  "required": ["name", "phone_number", "product", "platform", "issue_description"]
}
```

**Returns:** `{ "complaint_number": "11916" }` (or `{ "error": true }` on failure → Tara apologises and
offers to try again / take a callback). The middleware accepts free-text product/platform too (e.g.
"1.5L kettle", "bought on Zepto") and maps it to the right dropdown, but the enums above keep Tara
consistent. The middleware also **auto-fills the fields Freshdesk requires on create** (brand=truTRTL,
the nested product-category + model, group, GROUP CUSTOM, and placeholders `NA`/`0`/today for any
order-id/pincode/city/state/date the caller didn't give) — so Tara never has to ask for everything;
ops reconciles the rest from the WhatsApp invoice.

---

## After-Call Webhook
Agent settings → **Webhook / After-Call Webhook**:
- **URL:** `<MIDDLEWARE_URL>/ravan/after-call`
- **Method:** `POST`
- **Enabled:** yes
- No auth header needed. (If Ravan lets you append a query string, you may use
  `<MIDDLEWARE_URL>/ravan/after-call?key=<RAVAN_SHARED_SECRET>` for a light guard.)

Every completed call then logs a private summary note onto the caller's ticket (or creates a
`voice_agent` ticket if there isn't one). The middleware always replies `200 {ok:true}` so Ravan
won't retry-storm. **Heads-up:** Ravan's exact after-call payload isn't publicly documented — the
parser is defensive, but confirm the first real webhook in the logs and tell me if a field is missing.

---

## Flags in Tara's system prompt
- `{{can_lookup_status}}` → **true** once Function 1's URL is live.
- `{{can_register_complaint}}` → **true** (your decision). Keep the middleware's `TEST_AUTO_CLOSE=true`
  until you've watched the first live registration, then set it to `false` for production.
- `{{company_whatsapp}}` → `+91 95991 11390`.
