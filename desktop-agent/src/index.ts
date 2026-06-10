import { createRouter } from './router.js';

const PORT = parseInt(process.env.PORT || '3737');
const HOST = process.env.HOST || '0.0.0.0';

const app = createRouter();

const server = app.listen(PORT, HOST, () => {
  console.log(`DesktopWork Node HTTP Server running on http://localhost:${PORT}`);
  console.log(`  - Auth:  http://localhost:${PORT}/auth/login`);
  console.log(`  - Config: http://localhost:${PORT}/config`);
  console.log(`  - Agent: http://localhost:${PORT}/agent/chat`);
  console.log(`  - Skills: http://localhost:${PORT}/skills`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});