# truTRTL Voice-Agent ↔ Freshdesk Middleware

A small **Node.js + Express** service that connects the **truTRTL "Tara" voice agent** (on Ravan/Agni)
to **Freshdesk** so the agent can **look up and register warranty
complaints live, during the call**. It exposes three HTTPS endpoints, returns tiny voice-friendly
JSON, and **never 500s the voice agent** — on any failure it degrades to `{found:false}` / `{error:true}`.

> New here? Read **[FRESHDESK_ACCOUNT_NOTES.md](./FRESHDESK_ACCOUNT_NOTES.md)** for a plain-language
> explanation of how this client's Freshdesk is actually set up (it's a multi-brand account with
> specific field names), **[RAVAN_CUSTOM_FUNCTIONS.md](./RAVAN_CUSTOM_FUNCTIONS.md)** for the exact
> configs to paste into the Ravan UI, **[BACKPORT_2026-07.md](./BACKPORT_2026-07.md)** for the
> latest security fixes and the deploy gate that goes with them, and
> **[VPS_DEPLOY.md](./VPS_DEPLOY.md)** to deploy it.

**Live base URL: `https://trutrtl-support.digidzn.com`** (DIGIDZN VPS — Docker + Traefik behind
CyberPanel). The old Render deploy is retired; its artifacts sit in
[`_render-legacy/`](./_render-legacy/README.md) for reference only.

## Endpoints
| Method & path | Purpose | Auth |
|---|---|---|
| `POST /freshdesk/complaint-status` | Status by `complaint_number` (ticket id) **or** `phone_number`, gated by a server-side identity check on `caller_stated_name` | `Bearer` |
| `POST /freshdesk/register-complaint` | Create a warranty ticket, returns the number — or fails honestly with a `reason` and no number | `Bearer` |
| `POST /ravan/after-call` | Log the call summary/sentiment onto a ticket | `?key=${RAVAN_SHARED_SECRET}` query param — **required**, 401s without it |
| `GET /health` | Liveness probe | none |

Auth in (status/register): `Authorization: Bearer ${RAVAN_SHARED_SECRET}`.
Auth in (after-call): `?key=${RAVAN_SHARED_SECRET}` on the webhook URL — a missing or wrong key now
gets a `401`, not a silent pass-through (see [BACKPORT_2026-07.md](./BACKPORT_2026-07.md)).
Auth out: `Authorization: Basic base64("${FRESHDESK_API_KEY}:X")` to `https://${FRESHDESK_DOMAIN}/api/v2/`.

## Guardrails baked into the two lookup/write paths
- **Brand filter** — `digicart.freshdesk.com` is one desk shared by four brands (MILTON, APARNA, FKSB,
  truTRTL) over one ticket-id sequence. Every ticket fetched by id, by phone, or via after-call is
  checked against `cf_brand121540 === 'truTRTL'` before any field of it is used. A ticket that fails
  the check is treated exactly like a genuine miss (`{found:false}`) — the caller is never told
  "that's someone else's ticket."
- **Identity gate** — `complaint-status` compares `caller_stated_name` to the ticket's requester
  **server-side** and returns only a `name_matches` boolean; the real requester name never enters the
  voice agent's context. Case detail (`status_label`, `product`, `latest_update`, …) is added to the
  response only when the name matches.
- **Honest registration failure** — `register-complaint` refuses to create a ticket it can't file
  correctly (an unmapped product/platform, or a real product/channel with no CRM node) rather than
  defaulting to a guessed category or platform. See `BACKPORT_2026-07.md` for the full reason-code list.

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

## Deploy — DIGIDZN VPS (`trutrtl-support.digidzn.com`)
Full runbook: **[VPS_DEPLOY.md](./VPS_DEPLOY.md)**. In short:
1. A-record → the VPS (Cloudflare **grey** cloud), then `cp .env.example .env` on the box and fill it.
2. `docker compose up -d --build` — one stateless container on the shared external `edge` network;
   Traefik (internal, `127.0.0.1:8081`) routes to it by `Host()`, CyberPanel terminates TLS in front.
3. Copy `https://trutrtl-support.digidzn.com` into the three Ravan configs
   (`RAVAN_CUSTOM_FUNCTIONS.md`), keeping `?key=` on the after-call webhook.

Two things that silently break this deploy if you skip them — both are steps in the runbook, not
optional polish:
- **`WHAPI_ENABLED=true` + token** (D-2), or the document-request WhatsApp is never sent, nothing is
  logged, and every ticket stalls waiting for an invoice the customer was never asked for.
- **`TEST_AUTO_CLOSE=true` for the first run-through, then `false`** (D-3). It is not an off-switch:
  tickets are still real and the WhatsApp still goes out. Registration goes live the moment
  Function 2's URL is pasted into the Agent Builder.

Render is retired (`_render-legacy/`) — its free-tier cold starts were the "Tara goes silent" defect.
Other targets (Vercel/Lambda/Workers) would still work — the logic in `src/lib` is deploy-agnostic;
only `src/server.js` is Express-specific.

## How it's built (design notes)
- **Frugal Freshdesk calls** — the account allows only **~40 req/min**, shared with existing
  automation. Status lookups are cached briefly (`STATUS_CACHE_TTL_MS`), `include` is minimal, and 429s
  are retried once honouring `Retry-After` (capped at 2s to protect call latency).
- **Defensive Ravan parsing** — Ravan's request contract isn't publicly documented, so bodies are
  accepted both flat (`{complaint_number}`) and wrapped (`{args:{…}}` / `{parameters:{…}}`); the
  after-call payload is parsed leniently across likely field paths.
- **Honesty guardrails** — phone lookup searches both `mobile` and `phone` with ±91 variants; status
  reads only voice a note if it's clearly customer-facing, else a safe status-derived next step.
- **Idempotency** — register dedups on `phone+category+issue text` (5-min window, `IDEMPOTENCY_WINDOW_MS`)
  so a caller's legitimate second complaint about a different issue isn't silently merged into the
  first; after-call dedups on `call_session_id`. In-memory — fine on the VPS, which runs exactly one
  replica (keep it that way; see VPS_DEPLOY.md § Scaling caveat). For multi-instance/serverless,
  replace `src/lib/idempotency.js`'s `TtlStore` with a Redis-backed store (`SET key EX 300`).
- **Redacted logging** — phone/email/name/API-key never logged in clear (`src/lib/logger.js`).

## Project layout
```
Dockerfile             production image (node:20-alpine, non-root, tini)
docker-compose.yml     VPS stack — one container on the external `edge` network
VPS_DEPLOY.md          the deploy runbook (D-1/D-2/D-3)
_render-legacy/        retired Render blueprint + keep-alive, reference only
src/
  server.js            entry (container/local)
  app.js               express wiring + error handling
  routes/              complaint-status, register-complaint, after-call
  lib/                 freshdesk, ravan, phone, html-strip, status-map, time-since,
                       product-map, platform-map, idempotency, stores, logger, auth, config
test/
  unit/helpers.test.js node:test unit tests (no network)
  curl-examples.sh     live end-to-end checks
```
