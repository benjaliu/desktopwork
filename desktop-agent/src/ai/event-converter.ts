// src/ai/event-converter.ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStreamEvent } from './types.js';

/**
 * Convert SDK stream messages to platform-level events.
 * Returns null for events we don't expose to clients.
 */
export function convertSDKMessage(msg: SDKMessage): AgentStreamEvent | null {
  // Stream delta: text_delta
  if (msg.type === 'stream_event') {
    const ev = (msg as any).event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      return {
        type: 'text_delta',
        delta: ev.delta.text,
        contentIndex: ev.index ?? 0,
      };
    }
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      return {
        type: 'tool_use_start',
        id: ev.content_block.id,
        name: ev.content_block.name,
      };
    }
    return null;
  }

  // Full assistant message
  if (msg.type === 'assistant') {
    return {
      type: 'assistant_message',
      // Pass through SDK raw message (frontend extracts content blocks as needed)
      message: (msg as any).message,
      sessionId: (msg as any).session_id,
    };
  }

  // Round end
  if (msg.type === 'result') {
    return {
      type: 'session_done',
      sessionId: (msg as any).session_id,
      isError: (msg as any).is_error ?? false,
      cost: (msg as any).total_cost_usd,
      turns: (msg as any).num_turns,
      duration: (msg as any).duration_ms,
    };
  }

  // Other types (system / user / tool / etc.) not exposed to frontend yet
  return null;
}