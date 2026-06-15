// src/platform/types.ts
export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface AgentConfig {
  provider: string;
  model: string;
  apiKey: string;
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