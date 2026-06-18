// src/platform/config.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_PATH, CONFIG_DIR } from './paths.js';
import type { AgentConfig, DesktopWorkConfig } from './types.js';
import { getApiKey, setApiKey, resolveAccount } from './keychain.js';

/**
 * One-time migration: convert a plaintext `apiKey` field (v0.x legacy) to the
 * keychain-based `apiKeyRef` reference.
 * If the old field exists and the new field does NOT, write the key to keychain
 * and replace the field.
 */
async function migrateConfig(cfg: DesktopWorkConfig): Promise<DesktopWorkConfig> {
  // Cast to access legacy field that existed before the type was updated.
  // After migration the disk JSON will no longer contain 'apiKey'.
  const agentAny = cfg.agent as any;
  const hasLegacyApiKey =
    'apiKey' in agentAny && agentAny.apiKey && !cfg.agent.apiKeyRef;
  if (!hasLegacyApiKey) return cfg;

  await setApiKey('anthropic', agentAny.apiKey as string);
  cfg.agent = {
    ...cfg.agent,
    apiKeyRef: 'keytar:anthropic',
  };
  delete agentAny.apiKey;
  console.log('[config] Migrated plaintext apiKey to OS keychain');
  return cfg;
}

export async function loadConfig(): Promise<DesktopWorkConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as DesktopWorkConfig;
    const migrated = await migrateConfig(cfg);
    if (migrated !== cfg) {
      await saveConfig(migrated);
    }
    return migrated;
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

  // If the caller sent a plaintext apiKey, write it to keychain and convert
  // to an apiKeyRef before persisting.
  const agentAny = partial.agent as any;
  if (agentAny?.apiKey) {
    const account = resolveAccount(current.agent.apiKeyRef);
    await setApiKey(account, agentAny.apiKey as string);
    partial = {
      ...partial,
      agent: {
        ...(partial.agent as any),
        apiKeyRef: `keytar:${account}`,
      } as AgentConfig,
    };
    // Remove plaintext field so it never hits disk
    const { apiKey: _apiKey, ...agentWithoutKey } = partial.agent as any;
    partial = {
      ...partial,
      agent: agentWithoutKey as DesktopWorkConfig['agent'],
    };
  }

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
      apiKeyRef: '',
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