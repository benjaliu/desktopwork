import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'fs';
import { EventStream } from '../vendor/bundles/llm-core.esm.js';
import type { AgentMessage } from '../vendor/bundles/agent-core.esm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// ---------------------------------------------------------------------------
// Session Storage（复用现有 session.ts 的 JSONL 逻辑）
// ---------------------------------------------------------------------------

function resolveDataDir(): string {
  const home = process.env.HOME || '';
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || home, 'desktopwork', '.openclaw');
  }
  return join(home, '.local', 'share', 'desktopwork', '.openclaw');
}

function resolveSessionsDir(): string {
  return join(resolveDataDir(), 'sessions');
}

function sessionFile(sessionKey: string): string {
  const dir = resolveSessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionKey}.jsonl`);
}

function uuid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function getMessages(sessionKey: string): Promise<AgentMessage[]> {
  const file = sessionFile(sessionKey);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf-8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function appendMessage(sessionKey: string, msg: AgentMessage): Promise<void> {
  const file = sessionFile(sessionKey);
  appendFileSync(file, JSON.stringify(msg) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// buildStreamFn — 协议自适应（OpenAI / Anthropic SSE）
// ---------------------------------------------------------------------------

interface ProtocolResult {
  events: AsyncGenerator<any, void, unknown>;
  stop: () => void;
}

function buildStreamFn(baseUrl: string, apiKey: string, model: string) {
  const resolvedBaseUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
  const isAnthropic = resolvedBaseUrl.includes('anthropic') || resolvedBaseUrl.includes('.anthropic');

  return async function streamSimple(
    messages: any[],
    options: { signal?: AbortSignal; headers?: Record<string, string> } = {}
  ): Promise<EventStream> {
    const controller = new AbortController();
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    let fetchOptions: RequestInit = { method: 'POST', headers, signal: controller.signal as any };

    let url: string;
    let body: any;

    if (isAnthropic) {
      // Anthropic Messages API
      url = `${resolvedBaseUrl}/messages`;
      body = {
        model,
        messages: messages.filter((m: any) => m.role !== 'system'),
        system: messages.find((m: any) => m.role === 'system')?.content || '',
        stream: true,
        max_tokens: 4096,
      };
    } else {
      // OpenAI Responses / Chat API
      url = `${resolvedBaseUrl}/chat/completions`;
      body = { model, messages, stream: true };
    }

    fetchOptions.body = JSON.stringify(body);

    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LLM API error ${response.status}: ${err}`);
    }

    if (!response.body) throw new Error('No response body');

    // Create an EventStream that yields events
    const eventQueue: any[] = [];
    let resolveNext: ((v: IteratorResult<any>) => void) | null = null;
    let finished = false;

    async function processStream() {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6).trim();
            if (data === '[DONE]') {
              finished = true;
              eventQueue.push({ type: 'done' });
              resolveNext?.({ value: eventQueue.shift(), done: false });
              return;
            }

            try {
              const parsed = JSON.parse(data);

              if (isAnthropic) {
                // Anthropic SSE: content_block_delta, message_end, etc.
                if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta?.text || '';
                  if (delta) {
                    const event = {
                      type: 'text_delta',
                      contentIndex: 0,
                      delta,
                      partial: { role: 'assistant', content: delta },
                    };
                    eventQueue.push(event);
                    resolveNext?.({ value: eventQueue.shift(), done: false });
                    resolveNext = null;
                  }
                } else if (parsed.type === 'message_delta') {
                  // Final message with usage
                  eventQueue.push({ type: 'done', message: parsed.message });
                  resolveNext?.({ value: eventQueue.shift(), done: false });
                  resolveNext = null;
                }
              } else {
                // OpenAI SSE: choice.delta.delta or choice.message.content
                const choice = parsed.choices?.[0];
                if (!choice) continue;

                if (choice.delta?.content || choice.delta?.delta?.text) {
                  const delta = choice.delta?.content || choice.delta?.delta?.text || '';
                  const event = {
                    type: 'text_delta',
                    contentIndex: choice.index || 0,
                    delta,
                    partial: { role: 'assistant', content: delta },
                  };
                  eventQueue.push(event);
                  resolveNext?.({ value: eventQueue.shift(), done: false });
                  resolveNext = null;
                }

                if (choice.finish_reason) {
                  eventQueue.push({ type: 'done', message: choice.message });
                  resolveNext?.({ value: eventQueue.shift(), done: false });
                  resolveNext = null;
                }
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      } finally {
        finished = true;
        resolveNext?.({ value: undefined, done: true });
      }
    }

    processStream().catch(() => {});

    return {
      async next() {
        if (eventQueue.length > 0) {
          return { value: eventQueue.shift()!, done: false };
        }
        if (finished) return { value: undefined, done: true };
        return new Promise<IteratorResult<any>>((resolve) => {
          resolveNext = resolve;
        });
      },
      return() { controller.abort(); return Promise.resolve({ value: undefined, done: true }); },
      throw(e) { controller.abort(); return Promise.reject(e); },
      [Symbol.asyncIterator]() { return this; },
    } as unknown as EventStream;
  };
}

// ---------------------------------------------------------------------------
// Load agent-core bundle
// ---------------------------------------------------------------------------

let agentCore: any = null;

async function getAgentCore() {
  if (!agentCore) {
    agentCore = await import('../vendor/bundles/agent-core.esm.js');
  }
  return agentCore;
}

// ---------------------------------------------------------------------------
// POST /agent/chat
// ---------------------------------------------------------------------------

router.post('/chat', async (req, res) => {
  const { message, sessionKey = 'default', stream = true } = req.body as {
    message?: string;
    sessionKey?: string;
    stream?: boolean;
  };

  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  // Load config
  const { default: configModule } = await import('./config.js');
  // We need to read the config directly here to avoid circular deps
  const fs = await import('fs');
  const configPath = join(process.env.HOME || '', '.config', 'desktopwork', 'config.json');
  let agentConfig = { model: 'gpt-4o', provider: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1' };
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      agentConfig = { ...agentConfig, ...(raw.agent || {}) };
    }
  } catch { /* use defaults */ }

  const { model, apiKey, baseUrl } = agentConfig;

  // Build messages from session history
  const history = await getMessages(sessionKey);
  const userMsg: AgentMessage = {
    id: uuid(),
    role: 'user',
    content: message,
    timestamp: Date.now(),
  };

  const llmMessages = [
    ...history.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
    { role: 'user' as const, content: message },
  ];

  if (!stream) {
    // Non-streaming: collect all deltas then return
    const streamFn = buildStreamFn(baseUrl, apiKey, model);
    try {
      const core = await getAgentCore();
      const agentLoop = core.agentLoop;
      const stream2 = await agentLoop(llmMessages, {}, { model, streamFn });
      let fullText = '';
      for await (const event of stream2) {
        if (event.type === 'text_delta') {
          fullText += event.delta;
        }
      }
      const assistantMsg: AgentMessage = {
        id: uuid(),
        role: 'assistant',
        content: fullText,
        timestamp: Date.now(),
      };
      await appendMessage(sessionKey, userMsg);
      await appendMessage(sessionKey, assistantMsg);
      return res.json({ text: fullText, sessionKey });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Streaming: SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamFn = buildStreamFn(baseUrl, apiKey, model);

  (async () => {
    try {
      const core = await getAgentCore();
      const agentLoop = core.agentLoop;
      const eventStream = await agentLoop(llmMessages, {}, { model, streamFn });

      let fullText = '';

      for await (const event of eventStream) {
        if (event.type === 'text_delta') {
          fullText += event.delta;
          res.write(`data: ${JSON.stringify({ type: 'text_delta', delta: event.delta })}\n\n`);
        }
        if (event.type === 'done') {
          const assistantMsg: AgentMessage = {
            id: uuid(),
            role: 'assistant',
            content: fullText,
            timestamp: Date.now(),
          };
          await appendMessage(sessionKey, userMsg);
          await appendMessage(sessionKey, assistantMsg);
          res.write(`data: ${JSON.stringify({ type: 'message_end', content: fullText })}\n\n`);
          res.end();
          return;
        }
      }
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
      res.end();
    }
  })();

  // Keep request alive until SSE closes
  req.on('close', () => {});
});

export default router;