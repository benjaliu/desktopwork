// src/platform/config.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_PATH, CONFIG_DIR } from './paths.js';
import type { DesktopWorkConfig } from './types.js';

export async function loadConfig(): Promise<DesktopWorkConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as DesktopWorkConfig;
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      const def = getDefaultConfig();
      await saveConfig(def);
      return def;
    }
    throw e;
  }
}

export async function saveConfig(cfg: DesktopWorkConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

export async function updateConfig(partial: Partial<DesktopWorkConfig>): Promise<DesktopWorkConfig> {
  const current = await loadConfig();
  // Deep merge agent so partial { agent: { baseUrl: "..." } } doesn't wipe other agent fields.
  const updated: DesktopWorkConfig = {
    ...current,
    ...partial,
    agent: { ...current.agent, ...(partial.agent ?? {}) },
  };
  await saveConfig(updated);
  return updated;
}

export function getDefaultConfig(): DesktopWorkConfig {
  return {
    agent: {
      provider: 'custom',
      model: 'MiniMax-M3',
      apiKey: '',
      baseUrl: '',
    },
    system: {
      port: 3737,
      host: '127.0.0.1',
      dataDir: '',
      autoStart: false,
      logLevel: 'info',
    },
    enabledSkills: [],
    enabledApps: ['bot-chat', 'settings'],
  };
}