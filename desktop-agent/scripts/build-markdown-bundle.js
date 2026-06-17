#!/usr/bin/env node
// scripts/build-markdown-bundle.js
//
// v0.3.1.18: Bundle marked + marked-highlight + highlight.js (5 languages)
// into a single ESM file for browser consumption.
//
// Output: apps/_shared/markdown.bundle.js
// CI: this script runs after pnpm install in build.yml before the deploy step.
//
// Usage:
//   node scripts/build-markdown-bundle.js
//   pnpm build:markdown

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENTRY = join(ROOT, 'apps', '_shared', 'markdown.entry.js');
const OUT = join(ROOT, 'apps', '_shared', 'markdown.bundle.js');
const HLJS_THEME_SRC = join(ROOT, 'node_modules', 'highlight.js', 'styles', 'atom-one-dark.css');
const HLJS_THEME_DEST = join(ROOT, 'apps', '_shared', 'highlight-theme.css');

if (!existsSync(ENTRY)) {
  console.error(`[build-markdown] ERROR: entry file not found: ${ENTRY}`);
  process.exit(1);
}

console.log(`[build-markdown] Bundling ${ENTRY} → ${OUT}`);

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: false, // keep readable for debugging per spec §5.6.x.3
  sourcemap: false,
  outfile: OUT,
  // No external: fully bundle into single file (offline-use, no CDN)
  // No platform='browser' to keep output portable
  logLevel: 'info',
});

// Also copy atom-one-dark theme for the chat/dashboard pages
if (existsSync(HLJS_THEME_SRC)) {
  copyFileSync(HLJS_THEME_SRC, HLJS_THEME_DEST);
  console.log(`[build-markdown] Copied highlight.js theme → ${HLJS_THEME_DEST}`);
} else {
  console.warn(`[build-markdown] WARN: highlight.js atom-one-dark theme not found at ${HLJS_THEME_SRC}`);
  console.warn('[build-markdown]   Code blocks will render with no syntax colors. Check highlight.js install.');
}

const stats = await import('node:fs').then(m => m.promises.stat(OUT));
console.log(`[build-markdown] DONE: ${OUT} (${(stats.size / 1024).toFixed(1)} KB)`);
