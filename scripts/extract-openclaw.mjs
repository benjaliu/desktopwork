#!/usr/bin/env node
/**
 * extract-openclaw.mjs
 *
 * Extract OpenClaw packages (agent-core, memory-host-sdk, llm-core) as single
 * ESM bundles for use in desktop-agent.
 *
 * Key fix for memory-host-sdk: dotenv uses dynamic require() which fails in ESM.
 * We inject a require shim so the bundle can load in Node.js ESM mode.
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ─── Args ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : fallback;
};

const OPENCLAW_PATH = getArg('openclaw', resolve(PROJECT_ROOT, 'vendor/openclaw'));
const OUTPUT_DIR = getArg('out', resolve(PROJECT_ROOT, 'desktop-agent/vendor/bundles'));
const VERBOSE = args.includes('--verbose');
const ESBUILD = resolve(OPENCLAW_PATH, 'node_modules/.bin/esbuild');

// ─── Require shim for ESM compatibility ────────────────────────────────────────
// dotenv (a CJS module) uses `require('fs')` at module eval time.
// esbuild converts this to a dynamic __require shim that throws in ESM
// (because global require is undefined in ESM modules).
// We inject a shim that provides require via createRequire.
const REQUIRE_SHIM = resolve(PROJECT_ROOT, 'scripts/require-shim.mjs');

// ─── Git info ─────────────────────────────────────────────────────────────────

function getGitInfo(repoPath) {
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd: repoPath, encoding: 'utf-8' }).trim();
    } catch {
      return 'unknown';
    }
  };
  const commit = run('git rev-parse HEAD');
  const branch = run('git rev-parse --abbrev-ref HEAD');
  const tag = run('git describe --tags --exact-match HEAD 2>/dev/null || echo ""');
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8'));
    version = pkg.version;
  } catch {}
  return { commit, branch, tag, version };
}

// ─── esbuild ───────────────────────────────────────────────────────────────────

function buildBundle({ entryPoint, outfile, bundleName, external = [], inject = [] }) {
  const extArgs = external.flatMap(e => [`--external:${e}`]);
  const injArgs = inject.map(p => [`--inject:${p}`]).flat();
  const absOutfile = resolve(outfile);
  const cmd = [
    ESBUILD, entryPoint,
    '--bundle', '--platform=node', '--format=esm',
    `--outfile=${absOutfile}`, '--sourcemap',
    ...extArgs,
    ...injArgs,
  ];

  if (VERBOSE) console.log(`[extract] Building ${bundleName}...`);
  try {
    execSync(cmd.join(' '), {
      cwd: OPENCLAW_PATH,
      stdio: VERBOSE ? 'inherit' : 'pipe',
      encoding: 'utf-8',
    });
    if (VERBOSE) console.log(`[extract] ✓ ${bundleName}`);
    return true;
  } catch (e) {
    console.error(`[extract] ✗ ${bundleName} failed: ${e.message}`);
    return false;
  }
}

// ─── Packages ───────────────────────────────────────────────────────────────

const PACKAGES = {
  'llm-core': {
    pkg: 'packages/llm-core',
    main: 'src/index.ts',
    external: ['typebox'],
  },
  'agent-core': {
    pkg: 'packages/agent-core',
    main: 'src/index.ts',
    external: ['ignore', 'yaml'],
  },
  'memory-host-sdk': {
    pkg: 'packages/memory-host-sdk',
    main: 'src/runtime.ts',   // runtime.ts exports the useful helpers (not engine.ts which is just re-exports)
    external: [],
    inject: [REQUIRE_SHIM],   // dotenv requires fs dynamically, needs require shim in ESM
  },
};

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('[extract-openclaw] Starting...');
  console.log(`[extract-openclaw] OpenClaw: ${OPENCLAW_PATH}`);
  console.log(`[extract-openclaw] Output:   ${OUTPUT_DIR}`);

  if (!existsSync(OPENCLAW_PATH)) {
    console.error(`[extract-openclaw] ERROR: OpenClaw path not found: ${OPENCLAW_PATH}`);
    process.exit(1);
  }
  if (!existsSync(ESBUILD)) {
    console.error(`[extract-openclaw] ERROR: esbuild not found at ${ESBUILD}`);
    process.exit(1);
  }

  const gitInfo = getGitInfo(OPENCLAW_PATH);
  console.log(`[extract-openclaw] Git commit: ${gitInfo.commit}`);
  console.log(`[extract-openclaw] OpenClaw version: ${gitInfo.version}`);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const results = {};

  // llm-core
  const llmOut = join(OUTPUT_DIR, 'llm-core.esm.js');
  const llmSuccess = buildBundle({
    entryPoint: join(OPENCLAW_PATH, PACKAGES['llm-core'].pkg, PACKAGES['llm-core'].main),
    outfile: llmOut,
    bundleName: 'llm-core',
    external: PACKAGES['llm-core'].external,
  });
  results['llm-core'] = { success: llmSuccess, output: llmOut };

  if (!llmSuccess) {
    console.error('[extract-openclaw] llm-core build failed, aborting');
    process.exit(1);
  }

  // agent-core
  const agentOut = join(OUTPUT_DIR, 'agent-core.esm.js');
  const agentSuccess = buildBundle({
    entryPoint: join(OPENCLAW_PATH, PACKAGES['agent-core'].pkg, PACKAGES['agent-core'].main),
    outfile: agentOut,
    bundleName: 'agent-core',
    external: PACKAGES['agent-core'].external,
  });
  results['agent-core'] = { success: agentSuccess, output: agentOut };

  // memory-host-sdk
  const memSdk = PACKAGES['memory-host-sdk'];
  const memOut = join(OUTPUT_DIR, 'memory-host-sdk.esm.js');
  const memSuccess = buildBundle({
    entryPoint: join(OPENCLAW_PATH, memSdk.pkg, memSdk.main),
    outfile: memOut,
    bundleName: 'memory-host-sdk',
    external: memSdk.external,
    inject: memSdk.inject,
  });
  results['memory-host-sdk'] = { success: memSuccess, output: memOut };

  const allSuccess = Object.values(results).every(r => r.success);

  // Version manifest
  const bundles = {};
  for (const [name, { output, success }] of Object.entries(results)) {
    const size = existsSync(output) ? Math.round(statSync(output).size / 1024) : 0;
    bundles[name] = { file: basename(output), status: success ? 'ok' : 'failed', sizeKB: size };
  }

  const manifest = {
    extractedAt: new Date().toISOString(),
    openclaw: { path: OPENCLAW_PATH, ...gitInfo },
    bundles,
  };

  const manifestPath = join(OUTPUT_DIR, 'OPENCLAW_VERSIONS.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[extract-openclaw] Version manifest → ${manifestPath}`);

  console.log('\n[extract-openclaw] Summary:');
  for (const [name, { success, output }] of Object.entries(results)) {
    const status = success ? '✓' : '✗';
    const size = existsSync(output) ? `${Math.round(statSync(output).size / 1024)}KB` : 'N/A';
    console.log(`  ${status} ${name}: ${size}`);
  }

  process.exit(allSuccess ? 0 : 1);
}

main().catch(e => {
  console.error('[extract-openclaw] Fatal:', e);
  process.exit(1);
});