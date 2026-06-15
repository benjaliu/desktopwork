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
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  logger.error(`startup failed: ${e}`);
  process.exit(1);
});