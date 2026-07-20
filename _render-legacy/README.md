# Retired — Render-specific artifacts

These are kept for reference only. **This service now deploys to the DIGIDZN VPS**
(Docker + Traefik + CyberPanel front-door) at `trutrtl-support.digidzn.com`, not
Render — see [`../VPS_DEPLOY.md`](../VPS_DEPLOY.md). This is item **D-1** of
`TRUTRTL_JULY_2026_CHANGE_PLAN.md` §8.

- `render.yaml` — the Render Blueprint. On the VPS the equivalent config lives in
  `../docker-compose.yml` + `../.env` (env vars are set in `.env`, not a dashboard).
  ⚠ **Do not treat this file as the env-var inventory.** It never declared the WHAPI
  trio (`WHAPI_ENABLED` / `WHAPI_TOKEN` / `WHAPI_BASE_URL`) or `CF_PRODUCT_CATEGORY`
  / `CF_PRODUCT_SKU` / `CF_GROUP_CUSTOM*`, so a by-the-book Blueprint deploy shipped a
  service that silently never sent the document-request WhatsApp. That is **D-2**, and
  it is the single most expensive omission in this file. `../.env.example` — not this
  file — is the complete list.
- `keepalive.yml` — a GitHub Action that pinged Render every 5 min so the service never
  slept. **Not needed on the VPS**: the container runs `restart: unless-stopped`, so
  there is no cold start / spin-down to defend against. It was also failing open twice
  over: `|| true` meant a dead service never turned the run red, and GitHub
  auto-disables a scheduled workflow after 60 days of repo inactivity (last commit
  2026-06-09 → the cron was due to die around 2026-08-08, unnoticed). Moving it here
  removes a monitor that only ever looked like one.
  **Note the gap this leaves:** there is now no uptime alerting on this service at all.
  Add one against `https://trutrtl-support.digidzn.com/health` (any external monitor
  that alerts on failure — the point is that it must go RED, unlike the above).

> Restoring Render is not a supported path. If it ever happens, the cold-start
> problem returns as defect 11 ("chup ho jati hai" — Tara goes silent mid-call),
> because a 30–60 s cold start blows past Ravan's function timeout several times over.
