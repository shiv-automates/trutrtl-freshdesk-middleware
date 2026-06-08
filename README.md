# truTRTL Voice-Agent ↔ Freshdesk Middleware

A small **Node.js + Express** service that connects the **truTRTL "Tara" voice agent** (on Ravan/Agni)
to **Freshdesk** so the agent can **look up and register warranty
complaints live, during the call**. It exposes three HTTPS endpoints, returns tiny voice-friendly
JSON, and **never 500s the voice agent** — on any failure it degrades to `{found:false}` / `{error:true}`.

> New here? Read **[FRESHDESK_ACCOUNT_NOTES.md](./FRESHDESK_ACCOUNT_NOTES.md)** for a plain-language
> explanation of how this client's Freshdesk is actually set up (it's a multi-brand account with
> specific field names), and **[RAVAN_CUSTOM_FUNCTIONS.md](./RAVAN_CUSTOM_FUNCTIONS.md)** for the exact
> configs to paste into the Ravan UI.

## Endpoints
| Method & path | Purpose | Auth |
|---|---|---|
| `POST /freshdesk/complaint-status` | Status by `complaint_number` (ticket id) **or** `phone_number` | `Bearer` |
| `POST /freshdesk/register-complaint` | Create a warranty ticket, returns the number | `Bearer` |
| `POST /ravan/after-call` | Log the call summary/sentiment onto a ticket | none (Ravan webhook) |
| `GET /health` | Liveness probe | none |

Auth in: `Authorization: Bearer ${RAVAN_SHARED_SECRET}`.
Auth out: `Authorization: Basic base64("${FRESHDESK_API_KEY}:X")` to `https://${FRESHDESK_DOMAIN}/api/v2/`.

## Setup & run locally
```bash
cd TrutrtL/trutrtl-freshdesk-middleware
npm install
cp .env.example .env          # then fill FRESHDESK_API_KEY + RAVAN_SHARED_SECRET
# generate a shared secret:
node -e "console.log('sk_trutrtl_'+require('crypto').randomBytes(24).toString('hex'))"

npm test                      # unit tests (no network)
npm run dev                   # http://localhost:3000  (auto-reload)
```
Smoke-test everything:
```bash
BASE=http://localhost:3000 SECRET=<your RAVAN_SHARED_SECRET> bash test/curl-examples.sh
```

## Configuration
All via env (see `.env.example`, which is pre-filled with this account's real field keys). Highlights:

| Var | Meaning |
|---|---|
| `FRESHDESK_DOMAIN` | your Freshdesk subdomain, e.g. `yourbrand.freshdesk.com` |
| `FRESHDESK_API_KEY` | Freshdesk agent API key (secret) |
| `RAVAN_SHARED_SECRET` | token Ravan must send as Bearer (you generate) |
| `COMPLAINT_ID_MODE` | `TICKET_ID` (complaint number = ticket id) |
| `CF_*` | Freshdesk custom-field keys (platform/product/brand/order/pin/city/state) |
| `DEFAULT_GROUP_ID` | `81000089580` ("with digiCART" intake queue) |
| `TEST_AUTO_CLOSE` | when `true`, new tickets are tagged `voice_agent_test` and immediately closed |
| `TIMEZONE` | `Asia/Kolkata` for "days since" math |

## ⚠️ Testing against the LIVE helpdesk
This is a **production** Freshdesk with real ops and automations. To test the **register** path safely,
run with **`TEST_AUTO_CLOSE=true`** — each test ticket is tagged `voice_agent_test` and set to Closed
immediately. Status/after-call **reads** are always safe. Turn `TEST_AUTO_CLOSE=false` for go-live.

## Deploy to Render
1. Push this folder to a Git repo.
2. Render → **New → Blueprint** (uses `render.yaml`), or **New → Web Service** with
   Build `npm ci`, Start `npm start`, Health check `/health`.
3. Set the two secret env vars in the dashboard: `FRESHDESK_API_KEY`, `RAVAN_SHARED_SECRET`
   (the rest come from `render.yaml`). Pick the **Singapore** region for low latency to India.
4. Copy the service URL into the three Ravan configs (see `RAVAN_CUSTOM_FUNCTIONS.md`).

Other targets (Vercel/Lambda/Workers) work too — the logic in `src/lib` is deploy-agnostic; only
`src/server.js` is Express-specific.

## How it's built (design notes)
- **Frugal Freshdesk calls** — the account allows only **~40 req/min**, shared with existing
  automation. Status lookups are cached briefly (`STATUS_CACHE_TTL_MS`), `include` is minimal, and 429s
  are retried once honouring `Retry-After` (capped at 2s to protect call latency).
- **Defensive Ravan parsing** — Ravan's request contract isn't publicly documented, so bodies are
  accepted both flat (`{complaint_number}`) and wrapped (`{args:{…}}` / `{parameters:{…}}`); the
  after-call payload is parsed leniently across likely field paths.
- **Honesty guardrails** — phone lookup searches both `mobile` and `phone` with ±91 variants; status
  reads only voice a note if it's clearly customer-facing, else a safe status-derived next step.
- **Idempotency** — register dedups on `phone+product` (5-min window); after-call dedups on
  `call_session_id`. In-memory (fine on single-instance Render). For multi-instance/serverless, replace
  `src/lib/idempotency.js`'s `TtlStore` with a Redis-backed store (`SET key EX 300`).
- **Redacted logging** — phone/email/name/API-key never logged in clear (`src/lib/logger.js`).

## Project layout
```
src/
  server.js            entry (Render/local)
  app.js               express wiring + error handling
  routes/              complaint-status, register-complaint, after-call
  lib/                 freshdesk, ravan, phone, html-strip, status-map, time-since,
                       product-map, platform-map, idempotency, stores, logger, auth, config
test/
  unit/helpers.test.js node:test unit tests (no network)
  curl-examples.sh     live end-to-end checks
```
