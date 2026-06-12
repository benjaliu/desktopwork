// src/apps/bot-chat/service.ts
import { agentService } from '../../ai/agent-service.js';
import {
  listSessions,
  getSessionMessages,
  deleteSession,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentStreamEvent } from '../../ai/types.js';
import type { ChatRequest, ChatResponse } from './types.js';

export class BotChatService {
  async *streamChat(req: ChatRequest, abortSignal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    yield* agentService.stream({
      prompt: req.message,
      sessionId: req.sessionId,
      abortSignal,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let content = '';
    let sessionId = '';
    // MiniMax-M3 (with includePartialMessages:true) emits BOTH:
    //   - text_delta events (streaming increments)
    //   - a final assistant_message event with text content blocks
    // Naively accumulating both causes duplication. Strategy:
    //   - Buffer text_delta into `textDeltaBuffer` while no text-bearing
    //     assistant_message has been seen.
    //   - When a text-bearing assistant_message arrives, write it to `content`
    //     and mark `sawAssistantText`. After this, skip further text_delta
    //     accumulation (it's the same content re-announced).
    //   - At end of stream: prefer `content` (assistant text). Fall back to
    //     `textDeltaBuffer` if no assistant text was emitted (e.g. warm-query
    //     path that only delivers text_delta).
    let textDeltaBuffer = '';
    let sawAssistantText = false;

    for await (const event of agentService.stream({ prompt: req.message, sessionId: req.sessionId })) {
      if (event.type === 'text_delta') {
        if (!sawAssistantText) {
          textDeltaBuffer += event.delta;
        }
      } else if (event.type === 'assistant_message') {
        // Extract text from all text-type content blocks.
        // Skip thinking/tool_use blocks — only user-visible text counts.
        const msg = event.message as { content?: Array<{ type: string; text?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              content += block.text;
              sawAssistantText = true;
            }
          }
        }
      } else if (event.type === 'session_done') {
        sessionId = event.sessionId;
      }
    }

    if (!sawAssistantText) {
      content = textDeltaBuffer;
    }

    return { content, sessionId, sessionKey: sessionId };
  }

  async listSessions(): Promise<import('@anthropic-ai/claude-agent-sdk').SDKSessionInfo[]> {
    try {
      return await listSessions();
    } catch {
      return [];
    }
  }

  async getMessages(sessionId: string): Promise<import('@anthropic-ai/claude-agent-sdk').SessionMessage[]> {
    return await getSessionMessages(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await deleteSession(sessionId);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await renameSession(sessionId, title);
  }
}

export const botChatService = new BotChatService();