# Deploy the truTRTL middleware on the DIGIDZN VPS

> **Plan items:** D-1 (Render → VPS), D-2 (the WHAPI gate — read §2.5, it is the one that
> silently breaks every ticket), D-3 (`TEST_AUTO_CLOSE`). See
> `../TRUTRTL_JULY_2026_CHANGE_PLAN.md` §8.
>
> Replaces the Render deploy. This service now runs as a Docker container on the shared
> DIGIDZN VPS at **`trutrtl-support.digidzn.com`**, routed exactly like Mixpost
> (`social.digidzn.com`), digidzn-os (`app.digidzn.com`) and the ELLE Home middleware
> (`ellehome-support.digidzn.com`, live today — the working reference for this file).

## ⛔ Non-negotiable rules for this box (it has been wiped once already)

1. **CyberPanel / OpenLiteSpeed owns ports 80 and 443 natively on the host.** It is a
   teammate's, serving a live client site. **Do NOT touch it, reclaim its ports, or run
   anything that binds 80/443.** We route *around* it.
2. **Hard isolation.** This stack shares no DB, volume, or dependency with any other
   service. It joins only the `edge` network, only for routing.
3. **Never run a bare `docker compose down` that could remove the shared `edge` network.**
   `edge` is external and created once; leave it alone. Use `docker compose stop` /
   `restart` / `up -d` — never `down -v`, never `down --remove-orphans`.
4. **ELLE Home is live on this same box from an identical stack.** Every name in
   `docker-compose.yml` (`trutrtl-middleware`, image `trutrtl-freshdesk-middleware`,
   Traefik router/service `trutrtl`) is deliberately distinct from its `ellehome` twin.
   Do not copy an ellehome name in — you would either fail to start or re-point a LIVE
   ELLE Home router at truTRTL's container.

## The request path (why the config looks the way it does)

```
caller → Ravan (Tara) → HTTPS →
   CyberPanel/OpenLiteSpeed  :443   (teammate's; terminates TLS via its own Let's Encrypt cert)
      → reverse-proxy → 127.0.0.1:8081
   Traefik                   :8081  (internal-only, plain HTTP, Host()-router — infra/traefik)
      → Host(trutrtl-support.digidzn.com) →
   trutrtl-middleware        :3000  (this container)
```

TLS is CyberPanel's job. Traefik is internal and does no TLS — it has exactly ONE entrypoint,
named `web`, and no certresolver. The container only needs a `Host()` label + the `edge`
network (already set in `docker-compose.yml`). **Do not add `tls`, `certresolver` or
`websecure` labels** — they reference an entrypoint that does not exist on this box, and the
router will simply not be created.

---

## Prerequisites (should already be true on this box)

- Docker + the `edge` network: `docker network ls | grep edge` → if absent: `docker network create edge`
- Traefik running internal-only on `127.0.0.1:8081`. Verify:
  `curl -s http://127.0.0.1:8081/api/http/routers >/dev/null && echo OK`
- CyberPanel healthy and owning 80/443: `ss -tlnp | grep -E ':(80|443) '`

---

## Step 1 — DNS

Create an **A record**: `trutrtl-support.digidzn.com` → **`217.217.251.128`** (the VPS).

⚠ **Cloudflare must be GREY cloud (DNS only), not orange.** Proxying breaks CyberPanel's
Let's Encrypt HTTP-01 issuance in Step 4, and you will get a cert failure that looks like a
DNS problem.

Confirm before going further:
```bash
dig +short trutrtl-support.digidzn.com     # → 217.217.251.128
```

## Step 2 — Get the code + secrets onto the VPS

```bash
# a dir that does NOT collide with other services (ELLE Home uses /opt/ellehome)
sudo mkdir -p /opt/trutrtl && sudo chown "$USER" /opt/trutrtl
cd /opt/trutrtl
# copy this middleware folder here (git clone of its repo, scp, or rsync). Then:
cd trutrtl-freshdesk-middleware
cp .env.example .env
```

Now edit `.env` — fill the real values (**NEVER commit this file**):

| Var | Value | Note |
|---|---|---|
| `FRESHDESK_DOMAIN` | `digicart.freshdesk.com` | shared desk — 4 brands, one ticket sequence |
| `FRESHDESK_API_KEY` | the digicart key | ideally a dedicated "Voice Agent" agent profile |
| `RAVAN_SHARED_SECRET` | generate below | must match Ravan's Bearer **and** the after-call `?key=` |
| `CF_BRAND_VALUE` | `truTRTL` | byte-for-byte — it is a live dropdown value and the brand filter keys off it |
| `APP_DOMAIN` | `trutrtl-support.digidzn.com` | must match Steps 1, 3–5 |
| `NODE_ENV` | `production` | |
| `TEST_AUTO_CLOSE` | `true` for the first run-through | **D-3** — see §6 |
| WHAPI trio + `COMPANY_WHATSAPP` | see §2.5 | **D-2 — the deploy fails silently without this** |

```bash
node -e "console.log('sk_trutrtl_'+require('crypto').randomBytes(24).toString('hex'))"
```

> **`APP_DOMAIN` is load-bearing twice.** `docker-compose.yml` interpolates it into the
> Traefik `Host()` rule. If it is missing from `.env`, compose warns once, the rule becomes
> ``Host(`` `` `)``, Traefik refuses the router — and the **container still starts and looks
> perfectly healthy** while being unreachable from the internet. A healthy `docker compose ps`
> is not evidence that routing works; Step 3's curl is.

---

## ⛔ Step 2.5 — D-2: THE WHAPI GATE. DO NOT SKIP THIS STEP.

**This is the trap that makes a by-the-book deploy look successful and be broken.**

What happens on registration: the moment a ticket is created, the middleware WhatsApps the
customer the document request — the **invoice** and the **product video**. Ops cannot progress
a warranty claim without those two documents. Tara promises that message out loud on **every
single registration**.

Now the defect, verified in this repo:

| Where | What it actually says |
|---|---|
| `src/lib/config.js:55` | `enabled: bool(process.env.WHAPI_ENABLED, false)` — **defaults to FALSE** |
| `_render-legacy/render.yaml` | declares **no** WHAPI var at all — a Blueprint deploy provisions only what it lists |
| `src/lib/whapi.js:16` | `if (!config.whapi.enabled) return { skipped: true };` — **returns with no log line whatsoever** |
| `src/routes/register-complaint.js:365` | the Freshdesk note "Document-request WhatsApp sent…" is written **only** on `r?.ok` |

Put together: if `WHAPI_ENABLED` is unset, **the message is never sent, nothing is logged, and
nothing appears on the ticket.** The registration succeeds, the complaint number is real, Tara
reads it back, the customer waits for a WhatsApp that will never arrive — and every ticket
stalls waiting for documents nobody asked for in a way the customer can see. Silently. On every
call. This is exactly how it behaved on Render.

**Required in `.env` before the first live call:**
```dotenv
WHAPI_ENABLED=true
WHAPI_TOKEN=<the whapi.cloud channel token>
WHAPI_BASE_URL=https://gate.whapi.cloud
COMPANY_WHATSAPP=+91 95991 11390
```
The WHAPI channel must be bound to the truTRTL number so the message comes **from**
`+91 95991 11390` — a message from an unknown number reads as spam and gets ignored, which
fails the same way as not sending it.

**Verify it — three checks, all three required (config alone proves nothing):**
```bash
# 1. the process actually has the vars (not just the file)
docker compose exec trutrtl-middleware env | grep -E '^WHAPI_(ENABLED|BASE_URL)='   # → true / gate.whapi.cloud
#    (WHAPI_TOKEN deliberately not printed)

# 2. register ONE test complaint with TEST_AUTO_CLOSE=true, then:
docker compose logs --tail=100 | grep -i whapi     # → "whapi message sent"
#    Anything else — including NO whapi line at all — means it did not send.
#    Silence here is the failure mode, not a pass.

# 3. the ticket carries the private note:
#    "Document-request WhatsApp sent to the customer (invoice + video + review-for-extension offer)."
```

Then the only check that actually counts: **make a real call and confirm the WhatsApp lands on
the handset.** Logs prove we called WHAPI; only the phone proves WHAPI delivered.

> ⚠ **Use your own mobile number for that test.** The WhatsApp send happens **before**
> `TEST_AUTO_CLOSE` closes the ticket (`register-complaint.js` — send at ~line 364, close at
> ~line 375), and nothing gates it on test mode. `TEST_AUTO_CLOSE=true` protects ops' queue;
> it does **not** stop a real WhatsApp going to a real customer.

If the client has not yet handed over the WHAPI channel/token: **that blocks go-live.** Leave
`WHAPI_ENABLED=false`, and do not open the line believing registration works — it half-works,
in the half the customer can't see. Escalate it as a blocker rather than deploying around it.

---

## Step 3 — Build & start the container

```bash
cd /opt/trutrtl/trutrtl-freshdesk-middleware
docker compose up -d --build
docker compose ps                 # trutrtl-middleware = running (healthy)
docker compose logs --tail=30     # expect: "truTRTL ↔ Freshdesk middleware listening"
```

Confirm Traefik discovered it (labels/network correct):
```bash
curl -s http://127.0.0.1:8081/api/http/routers | grep -o 'trutrtl[^"]*'   # a router should appear
# and hit it through Traefik by faking the Host header:
curl -s -H 'Host: trutrtl-support.digidzn.com' http://127.0.0.1:8081/health
# → {"ok":true,"service":"trutrtl-freshdesk-middleware"}
```

Check you have not disturbed the neighbour:
```bash
curl -s -H 'Host: ellehome-support.digidzn.com' http://127.0.0.1:8081/health   # → still ELLE Home's
```

> ⚠ If the truTRTL router does NOT appear, the label convention on the live Traefik differs from
> the committed one. Compare against a container that works today and match it:
> `docker inspect ellehome-middleware --format '{{json .Config.Labels}}' | tr ',' '\n' | grep traefik`

## Step 4 — Put CyberPanel in front (public TLS) — the documented pattern

Same two moves used for `social.digidzn.com`, `app.digidzn.com` and `ellehome-support.digidzn.com`:

1. **Create the website + issue its own Let's Encrypt cert** (CyberPanel's ACME, separate from Traefik):
   ```bash
   cyberpanel createWebsite --package Default --owner admin \
     --domainName trutrtl-support.digidzn.com \
     --email admin@digidzn.com --php 8.1 --ssl 1
   ```
   If issuance fails, check Cloudflare is still **grey cloud** (Step 1) before anything else.
2. **Append a reverse-proxy block** to that vhost so OpenLiteSpeed forwards to Traefik, keeping the
   Host header (so Traefik's `Host()` rule still matches). Edit
   `/usr/local/lsws/conf/vhosts/trutrtl-support.digidzn.com/vhost.conf` and add the same
   `extprocessor` + `context /` proxy-to-`127.0.0.1:8081` block already used on the other vhosts
   (copy it from `ellehome-support.digidzn.com`'s vhost.conf and change the name). Then:
   ```bash
   systemctl restart lsws     # or: /usr/local/lsws/bin/lswsctrl restart
   ```

## Step 5 — Verify end to end (public HTTPS)

```bash
curl -s https://trutrtl-support.digidzn.com/health   # → {"ok":true,"service":"trutrtl-freshdesk-middleware"}
```
A 200 here means the full chain (CyberPanel TLS → Traefik → container) works.

Prove the after-call auth fix survived the host change (backport §1.4 — this 401s everything if
the `?key=` is dropped, so test both directions):
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://trutrtl-support.digidzn.com/ravan/after-call' -H 'Content-Type: application/json' -d '{}'
# → 401  (no key = rejected; if this returns 200 the auth hole is back)
```

## Step 6 — Point Ravan at the VPS, then D-3

⚠ **Do this only after BACKPORT_2026-07.md's deploy gate is satisfied** — the Ravan function
schema (`caller_stated_name`) and Tara's Phase 6 sequencing must move in the same window as the
code, or she can report no complaint status at all.

1. In `RAVAN_CUSTOM_FUNCTIONS.md`, set `<MIDDLEWARE_URL>` = `https://trutrtl-support.digidzn.com`
   for all three functions, and the after-call webhook to
   `https://trutrtl-support.digidzn.com/ravan/after-call?key=<RAVAN_SHARED_SECRET>`.
   **Re-check the `?key=` survived the host change** — pasting a new base URL is exactly when it
   gets lost, and it 401s silently on every call afterwards.
2. **D-3 — `TEST_AUTO_CLOSE=true` for the first live run-through.** Every ticket is tagged
   `voice_agent_test` and Closed immediately, so live ops isn't disturbed while you run the
   acceptance matrix (`BACKPORT_2026-07.md` §4 and the change plan §11).
   ```bash
   # after editing .env:
   docker compose up -d          # re-reads .env; no rebuild needed for an env-only change
   docker compose exec trutrtl-middleware env | grep TEST_AUTO_CLOSE   # → true
   ```
3. **Then, and only then, flip it for production:**
   ```dotenv
   TEST_AUTO_CLOSE=false
   ```
   ```bash
   docker compose up -d
   docker compose exec trutrtl-middleware env | grep TEST_AUTO_CLOSE   # → false. Confirm it, don't assume it.
   ```

> ⛔ **There is NO soft off-switch for registration.** `TEST_AUTO_CLOSE` is not one — it still
> creates real tickets in the live helpdesk and still fires a real WhatsApp (§2.5); it only closes
> them behind itself. Registration goes **live the moment Function 2's URL is pasted into the Agent
> Builder**, and the only way to stop it is to remove that function from the agent. Decide you are
> ready *before* you paste the URL, not after.
>
> Read the two together: with `TEST_AUTO_CLOSE=true` you are already filing live tickets and
> messaging live numbers. With it `false` you have merely stopped tidying up after yourself.

---

## Operations

```bash
# update to new code
cd /opt/trutrtl/trutrtl-freshdesk-middleware && git pull && docker compose up -d --build

# logs / status / restart (scoped to THIS stack only — never affects Mixpost/digidzn-os/ELLE Home)
docker compose logs -f
docker compose restart
docker compose ps
```

**Redeploy timing:** prefer outside call hours. `src/` has no SIGTERM handler (zero `process.on`
in the tree) and the after-call route does Freshdesk work *after* it responds, so a restart can
drop an in-flight private note. tini in the Dockerfile delivers the signal correctly; it does not
give the app a graceful shutdown it hasn't got.

**Backups:** none needed — the service is stateless (its in-memory stores are caches/dedup with
short TTLs; the source of truth is Freshdesk). A restart loses only the dedup window.

**Scaling caveat:** the dedup/idempotency stores are per-process. Keep this to **one replica**. If
it ever needs more, swap the in-memory stores for Redis first (`src/lib/idempotency.js`'s
`TtlStore` has that seam) — otherwise two replicas double-file tickets and double-log calls.

**Monitoring:** the Render keep-alive is retired (`_render-legacy/`) and nothing replaced it. Point
an external uptime monitor at `https://trutrtl-support.digidzn.com/health` and make sure it can
actually alert — the old one used `|| true`, so it never went red no matter what.

## Rollback

```bash
docker compose stop            # stops truTRTL only; leaves `edge`, Traefik and every neighbour up
```
Ravan then gets connection errors rather than wrong answers. To roll back code, check out the
previous commit and `docker compose up -d --build`. **Never** `docker compose down -v` on this box.
