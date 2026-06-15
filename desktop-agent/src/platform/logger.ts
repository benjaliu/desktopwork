// src/platform/logger.ts
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Level } from './types.js';
import { APP_DATA_DIR, LOG_DIR } from './paths.js';

// Level priority: trace=0, debug=1, info=2, warn=3, error=4
const LEVEL_PRIORITY: Record<Level, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function parseLevel(raw: string | undefined): Level {
  if (raw === 'trace' || raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

function currentLevel(): Level {
  // CLI flag wins (--log-level=debug), then env var, then default 'info'
  const cliIdx = process.argv.indexOf('--log-level');
  if (cliIdx !== -1 && process.argv[cliIdx + 1]) {
    return parseLevel(process.argv[cliIdx + 1]);
  }
  return parseLevel(process.env.LOG_LEVEL);
}

const LEVEL = currentLevel();

function shouldLog(level: Level): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[LEVEL];
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `desktop-agent-${date}.log`);
}

function metaString(meta?: object): string {
  if (!meta) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return '';
  }
}

let fileHandle: number | null = null;
let writeReady: Promise<void> | null = null;

async function ensureLogDir(): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
  }
}

async function writeLine(level: Level, msg: string, meta?: object): Promise<void> {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${level.toUpperCase()} ${msg}${metaString(meta)}\n`;

  // Always write to stdout/stderr so Tauri can capture it
  if (level === 'error') {
    console.error(`[node] ${msg}`, meta ?? '');
  } else {
    console.log(`[node] ${msg}`, meta ?? '');
  }

  // Write to file asynchronously (fire-and-forget for performance)
  ensureLogDir()
    .then(async () => {
      try {
        const fd = await open(logFilePath(), 'a');
        await fd.writeFile(line);
        await fd.close();
      } catch {
        // ignore file write errors
      }
    })
    .catch(() => {});
}

class Logger {
  private level: Level;
  private module: string;

  constructor(opts: { level?: Level; module?: string } = {}) {
    this.level = opts.level ?? LEVEL;
    this.module = opts.module ?? 'app';
  }

  trace(msg: string, meta?: object): void {
    writeLine('trace', `[${this.module}] ${msg}`, meta);
  }

  debug(msg: string, meta?: object): void {
    writeLine('debug', `[${this.module}] ${msg}`, meta);
  }

  info(msg: string, meta?: object): void {
    writeLine('info', `[${this.module}] ${msg}`, meta);
  }

  warn(msg: string, meta?: object): void {
    writeLine('warn', `[${this.module}] ${msg}`, meta);
  }

  error(msg: string, meta?: object): void {
    writeLine('error', `[${this.module}] ${msg}`, meta);
  }
}

// Default app logger — module field lets callers set context
export const logger = new Logger();

// Named export so callers can do `import { logger as myLogger } from ...`
export { Logger };