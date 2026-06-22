// src/index.ts
import { createRouter } from './router.js';
import { loadConfig } from './platform/config.js';
import { prewarmClaude } from './ai/startup-warmer.js';
import { logger } from './platform/logger.js';

const PORT = parseInt(process.env.PORT || '3737');
const HOST = process.env.HOST || '127.0.0.1';

async function main() {
  const cfg = await loadConfig();
  logger.info(`config loaded: provider=${cfg.agent.provider}, model=${cfg.agent.model}`);

  const app = createRouter();
  const server = app.listen(PORT, HOST, () => {
    logger.info(`HTTP server on http://${HOST}:${PORT}`);
    logger.info(`health: http://${HOST}:${PORT}/api/platform/health`);
  });

  prewarmClaude(cfg).catch((e) => {
    logger.error(`prewarm failed (will retry on first query): ${e.message}`);
  });

  const shutdown = (sig: string) => {
    logger.info(`received ${sig}, shutting down...`);
    server.close(() => {
      logger.info(`server closed, exiting`);
      process.exit(0);
    });
    // Force exit after 3s if server.close() hangs (e.g., stuck long-poll).
    // Critical for the app-update flow — installer waits for process exit.
    // .unref() so the timer itself doesn't keep the event loop alive.
    setTimeout(() => {
      logger.warn(`shutdown timeout (3s), forcing exit`);
      process.exit(1);
    }, 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  logger.error(`startup failed: ${e}`);
  process.exit(1);
});