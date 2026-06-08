// Express app: routes + JSON parsing + graceful error handling.
import express from 'express';
import { logger } from './lib/logger.js';
import { complaintStatusRouter } from './routes/complaint-status.js';
import { registerComplaintRouter } from './routes/register-complaint.js';
import { afterCallRouter } from './routes/after-call.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Capture raw body parse errors so we can return a clean 400 instead of a stack.
  app.use(express.json({ limit: '1mb' }));

  // Liveness probe (used by Render healthCheckPath).
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'trutrtl-freshdesk-middleware' }));

  app.use(complaintStatusRouter);
  app.use(registerComplaintRouter);
  app.use(afterCallRouter);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // Error handler (malformed JSON, etc.).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid_json' });
    }
    logger.error({ err: err?.message }, 'unhandled error');
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
