// src/platform/types.ts
export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface AgentConfig {
  provider: string;
  /** Model name is a runtime parameter. NOT validated by the app — any string is passed through to the SDK. */
  model: string;
  /**
   * Reference to where the API key is stored. Format: 'keytar:<account>'.
   * The actual key lives in OS keychain, NOT in this config file.
   */
  apiKeyRef: string;
  baseUrl?: string;
}

export interface SystemConfig {
  port: number;
  host: string;
  dataDir: string;
  autoStart: boolean;
  logLevel?: Level;
}

export interface DesktopWorkConfig {
  agent: AgentConfig;
  system: SystemConfig;
  enabledSkills: string[];
  enabledApps: string[];
}

export interface PlatformHealth {
  status: 'ok' | 'error';
  version: string;
  uptime: number;
  pid: number;
}