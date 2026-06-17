// src/ai/agent-service.ts
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { getWarmQuery, invalidateWarmQuery } from './startup-warmer.js';
import { loadConfig } from '../platform/config.js';
import { RUNTIME_DIR } from '../platform/paths.js';
import { convertSDKMessage } from './event-converter.js';
import type { AgentStreamEvent, AgentCallOptions } from './types.js';
import type { DesktopWorkConfig } from '../platform/types.js';

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
export function buildEnv(cfg: DesktopWorkConfig): Record<string, string | undefined> {
  return {
    ...process.env as Record<string, string>,
    ANTHROPIC_BASE_URL: cfg.agent.baseUrl || undefined,
    ANTHROPIC_AUTH_TOKEN: cfg.agent.apiKey || undefined,
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
    const env = buildEnv(cfg);

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

    // Prefer warm query (valid for one use only — WarmQuery.query() can only be called once)
    const warm = getWarmQuery();
    const q: Query = warm
      ? warm.query(opts.prompt)
      : query({ prompt: opts.prompt, options });

    // Invalidate warm query so subsequent calls don't try to reuse an exhausted WarmQuery.
    // After warm.query() is called, the same WarmQuery instance cannot be used again.
    // Next call will go through query() which still benefits from the prewarmed subprocess reuse.
    if (warm) {
      // Don't await — fire and forget; next request will recreate via query()
      invalidateWarmQuery();
    }

    try {
      // Track assistant message IDs that have been streamed via stream_event
      // (message_start). Used to dedup fallback text_delta from the eventual
      // assistant message — Anthropic streaming path emits the full assistant
      // message AFTER all stream_event text_delta, so without dedup we'd
      // double-yield. Non-streaming providers (e.g. MiniMax via Anthropic-
      // compatible endpoint) never emit stream_event, so the set stays empty
      // and we fallback to extracting text from the assistant message.
      const streamedMsgIds = new Set<string>();

      for await (const msg of q) {
        // Record msg_id from message_start so we know if a given assistant
        // message was already streamed via stream_event.
        if (msg.type === 'stream_event') {
          const ev = (msg as any).event;
          if (ev?.type === 'message_start' && ev?.message?.id) {
            streamedMsgIds.add(ev.message.id);
          }
        }

        // Fallback: when an assistant message arrives without any prior
        // stream_event text_delta (non-streaming provider), yield text_delta
        // events from its text content blocks. The frontend agent.js expects
        // text_delta + session_done; without this fallback it sees nothing
        // for MiniMax-style providers.
        if (msg.type === 'assistant') {
          const msgId = (msg as any).message?.id;
          if (msgId && !streamedMsgIds.has(msgId)) {
            const message = (msg as any).message;
            if (message?.content) {
              for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                  yield {
                    type: 'text_delta',
                    delta: block.text,
                    contentIndex: 0,
                  };
                }
              }
            }
          }
        }

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