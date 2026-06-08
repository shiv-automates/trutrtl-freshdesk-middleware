// Server entry point (Render / local).
import { config, assertRequiredConfig } from './lib/config.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';

assertRequiredConfig(); // fail fast if secrets are missing

const app = createApp();
app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      freshdesk: config.freshdeskDomain,
      mode: config.complaintIdMode,
      testAutoClose: config.testAutoClose,
    },
    'truTRTL ↔ Freshdesk middleware listening',
  );
});
