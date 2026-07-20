# truTRTL ↔ Freshdesk middleware — production image.
# Small, non-root, dependency-light. The app is a stateless ESM Node service
# that listens on $PORT (default 3000) and exposes GET /health.
FROM node:20-alpine

# tini gives us proper PID-1 signal handling, so `docker stop` / `compose up -d
# --build` delivers a real SIGTERM instead of it being swallowed by PID 1.
# ⚠ HONEST CAVEAT — tini is necessary but NOT sufficient here: src/server.js has
# no SIGTERM handler (grep confirms: zero `process.on` in src/), and the
# after-call route does Freshdesk work AFTER it has responded. So a redeploy can
# still drop an in-flight private note. Deploy outside call hours until a
# graceful-shutdown handler lands; do not read tini as "safe to redeploy mid-call".
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Install deps first (layer cache): only re-runs when the manifests change.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# App code.
COPY . .

# Run as the built-in unprivileged `node` user, not root.
USER node

EXPOSE 3000

# Liveness: hit our own /health with Node's built-in fetch (no curl/wget needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
