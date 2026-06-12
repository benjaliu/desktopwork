// src/ai/agent-service.ts
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { getWarmQuery } from './startup-warmer.js';
import { loadConfig } from '../platform/config.js';
import { RUNTIME_DIR } from '../platform/paths.js';
import { convertSDKMessage } from './event-converter.js';
import type { AgentStreamEvent, AgentCallOptions } from './types.js';

/**
 * Unified platform cwd: used for SDK subprocess startup and session queries.
 * Ensures all sessions are stored under `~/.claude/projects/-<encoded-runtime>/`.
 * (See §9.4 cross-platform encoding)
 */
export const PLATFORM_CWD = RUNTIME_DIR;

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Glob'];

/**
 * Build env vars for the SDK subprocess.
 *
 * KEY: SDK comment: `env` REPLACES the subprocess environment entirely.
 * Must spread `...process.env` so subprocess doesn't miss PATH / HOME etc.
 */
export function buildEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'desktopwork/0.1.0',
    DISABLE_TELEMETRY: '1',
    NODE_NO_WARNINGS: '1',
  };
}

export class AgentService {
  /**
   * Stream a call to the Agent.
   * - Reloads config per request (hot-update config)
   * - Prefers warm query (avoids restarting subprocess)
   * - Failure isolation: single failure doesn't affect Platform process
   */
  async *stream(opts: AgentCallOptions): AsyncGenerator<AgentStreamEvent> {
    const cfg = await loadConfig();
    const env = buildEnv();

    const options: Options = {
      model: cfg.agent.model,
      systemPrompt: opts.systemPrompt,
      cwd: PLATFORM_CWD,
      env,
      includePartialMessages: true, // ★ enable streaming
      resume: opts.sessionId,
      maxTurns: 20,
      tools: [],
      allowedTools: opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
      abortController: opts.abortSignal ? toAbortController(opts.abortSignal) : undefined,
    };

    // Prefer warm query
    const warm = getWarmQuery();
    const q: Query = warm
      ? warm.query(opts.prompt)
      : query({ prompt: opts.prompt, options });

    try {
      for await (const msg of q) {
        const event = convertSDKMessage(msg);
        if (event) yield event;
      }
    } catch (e: any) {
      // Emit session_done so frontend knows the stream ended
      yield {
        type: 'session_done',
        sessionId: opts.sessionId ?? '',
        isError: true,
      };
      throw e;
    }
  }
}

function toAbortController(signal: AbortSignal): AbortController {
  const c = new AbortController();
  signal.addEventListener('abort', () => c.abort());
  return c;
}

export const agentService = new AgentService();