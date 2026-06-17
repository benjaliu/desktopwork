// Usage: node test/smoke.mjs
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 3737;
const BASE = `http://127.0.0.1:${PORT}`;

function curl(url, opts = {}) {
  const cmd = `curl -s ${opts.method ? `-X ${opts.method} ` : ''}-H "Content-Type: application/json" ${opts.body ? `-d '${opts.body}' ` : ''}${url}`;
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (e) {
    console.error(`curl failed: ${cmd}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const outLog = fs.openSync(join(ROOT, 'smoke_out.log'), 'w');
const errLog = fs.openSync(join(ROOT, 'smoke_err.log'), 'w');

const tsxBin = join(ROOT, 'node_modules', '.bin', 'tsx');
const server = spawn(tsxBin, ['src/index.ts'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', outLog, errLog],
});

console.log(`[smoke] spawned server pid=${server.pid}`);

// Wait for server to start listening. On cold-startup with tsx loader +
// claude-agent-sdk prewarm, server can take 5-8s; bumped from 3s for
// reliability on slow runners (WSL2 / CI).
await sleep(8000);

// Health check
const health = curl(`${BASE}/api/platform/health`);
if (!health) {
  console.error('[smoke] FAIL: health check curl failed');
  process.kill(-server.pid, 'SIGTERM');
  process.exit(1);
}
try {
  const h = JSON.parse(health);
  if (h.status !== 'ok') throw new Error(`health status=${h.status}`);
  console.log('[smoke] PASS: /api/platform/health');
} catch (e) {
  console.error(`[smoke] FAIL: health response invalid: ${e.message}`);
  process.kill(-server.pid, 'SIGTERM');
  process.exit(1);
}

// Login check
const login = curl(`${BASE}/auth/login`, { method: 'POST', body: '{}' });
if (!login) {
  console.error('[smoke] FAIL: login curl failed');
  process.kill(-server.pid, 'SIGTERM');
  process.exit(1);
}
try {
  const l = JSON.parse(login);
  if (!l.token) throw new Error('no token in login response');
  console.log('[smoke] PASS: /auth/login returns token');
} catch (e) {
  console.error(`[smoke] FAIL: login response invalid: ${e.message}`);
  process.kill(-server.pid, 'SIGTERM');
  process.exit(1);
}

process.kill(-server.pid, 'SIGTERM');
console.log('[smoke] DONE');
process.exit(0);