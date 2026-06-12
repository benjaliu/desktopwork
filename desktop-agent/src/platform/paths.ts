// src/platform/paths.ts
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function getAppDataDir(): string {
  if (process.env.PLATFORM_APP_DATA) {
    return process.env.PLATFORM_APP_DATA;
  }
  switch (platform()) {
    case 'darwin':  return join(homedir(), 'Library', 'Application Support', 'desktopwork');
    case 'win32':   return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'desktopwork');
    default:        return join(homedir(), '.local', 'share', 'desktopwork');
  }
}

export const APP_DATA_DIR = getAppDataDir();
export const CONFIG_DIR   = join(APP_DATA_DIR, 'config', 'desktopwork');
export const RUNTIME_DIR  = join(APP_DATA_DIR, 'data', 'desktopwork', 'runtime');
export const LOG_DIR      = join(APP_DATA_DIR, 'logs');
export const CONFIG_PATH  = join(CONFIG_DIR, 'config.json');