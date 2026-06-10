import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { EventStream } from '@openclaw/llm-core';

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ProviderConfig {
  baseUrl: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  models: ModelConfig[];
}

export interface LLMConfig {
  providers: Record<string, ProviderConfig>;
  activeProvider: string;
}

export interface LLMCompleteOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxTokens?: number;
  metadata?: Record<string, string>;
}

export interface LLMResponse {
  stopReason: string;
  content: Array<{ type: string; text?: string }>;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
}

export type CompleteFn = (
  model: ModelConfig,
  context: { systemPrompt: string; messages: AgentMessage[] },
  options: LLMCompleteOptions
) => Promise<LLMResponse>;

export type StreamFn = (
  model: ModelConfig,
  context: { systemPrompt: string; messages: AgentMessage[] },
  options: LLMCompleteOptions
) => Promise<EventStream<LLMResponse>>;

// Re-export AgentMessage from agent-core
import type { AgentMessage } from '@openclaw/agent-core';
export type { AgentMessage };

export function loadLLMConfig(): LLMConfig {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    const models = config.models as any;

    if (!models?.providers) {
      throw new Error('No providers in config');
    }

    return {
      providers: models.providers as Record<string, ProviderConfig>,
      activeProvider: models.activeProvider || Object.keys(models.providers)[0]
    };
  } catch (e) {
    console.error('[llm] Failed to load config:', e);
    throw new Error('Failed to load LLM config');
  }
}

export function resolveModel(config: LLMConfig): ModelConfig {
  const providerName = config.activeProvider;
  const provider = config.providers[providerName];

  if (!provider) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const modelDef = provider.models?.[0];
  if (!modelDef) {
    throw new Error(`No models defined for provider: ${providerName}`);
  }

  return {
    id: modelDef.id,
    name: modelDef.name || modelDef.id,
    provider: providerName,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || '',
    contextWindow: modelDef.contextWindow,
    maxTokens: modelDef.maxTokens,
    reasoning: modelDef.reasoning,
    input: modelDef.input,
    cost: modelDef.cost
  };
}

export function resolveApiKey(provider: ProviderConfig, model: ModelConfig): string {
  // Priority: explicit model apiKey > provider apiKey > empty
  return model.apiKey || provider.apiKey || '';
}

export function resolveBaseUrl(provider: ProviderConfig): string {
  return provider.baseUrl || '';
}