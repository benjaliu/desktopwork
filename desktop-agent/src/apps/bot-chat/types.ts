// src/apps/bot-chat/types.ts
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ChatRequest {
  message: string;
  sessionId?: string;
  stream?: boolean;
}

export interface ChatResponse {
  content: string;
  sessionId: string;
  sessionKey: string;
}

export type { SDKSessionInfo, SessionMessage };