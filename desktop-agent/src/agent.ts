import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
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

const MAX_SESSION_KEY_LEN = 64;
const SESSION_KEY_REGEX = /^[a-zA-Z0-9_-]+$/;

function validateSessionKey(sessionKey: string): string {
  if (!SESSION_KEY_REGEX.test(sessionKey)) throw new Error('invalid sessionKey');
  if (sessionKey.length > MAX_SESSION_KEY_LEN) throw new Error('sessionKey too long');
  return sessionKey;
}

function sessionFile(sessionKey: string): string {
  const safeKey = validateSessionKey(sessionKey);
  const dir = resolveSessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${safeKey}.jsonl`);
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

const DEFAULT_MAX_TOKENS = 4096;

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

    const fetchOptions: RequestInit = { method: 'POST', headers, signal: controller.signal as any };

    let url: string;
    let body: any;

    if (isAnthropic) {
      url = `${resolvedBaseUrl}/messages`;
      body = {
        model,
        messages: messages.filter((m: any) => m.role !== 'system'),
        system: messages.find((m: any) => m.role === 'system')?.content || '',
        stream: true,
        max_tokens: DEFAULT_MAX_TOKENS,
      };
    } else {
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

    const stream = new EventStream();

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
              stream.end();
              return;
            }

            try {
              const parsed = JSON.parse(data);

              if (isAnthropic) {
                if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta?.text || '';
                  if (delta) {
                    stream.push({
                      type: 'text_delta',
                      contentIndex: 0,
                      delta,
                      partial: { role: 'assistant', content: delta },
                    });
                  }
                } else if (parsed.type === 'message_delta') {
                  stream.push({ type: 'done', message: parsed.message });
                }
              } else {
                const choice = parsed.choices?.[0];
                if (!choice) continue;

                if (choice.delta?.content || choice.delta?.delta?.text) {
                  const delta = choice.delta?.content || choice.delta?.delta?.text || '';
                  stream.push({
                    type: 'text_delta',
                    contentIndex: choice.index || 0,
                    delta,
                    partial: { role: 'assistant', content: delta },
                  });
                }

                if (choice.finish_reason) {
                  stream.push({ type: 'done', message: choice.message });
                }
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      } finally {
        if (!stream.done) stream.end();
      }
    }

    processStream().catch((e) => stream.end(e));

    return stream;
  };
}

// ---------------------------------------------------------------------------
// Load agent-core bundle
// ---------------------------------------------------------------------------

let agentCore: any = null;



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

  // Validate sessionKey before use
  try {
    validateSessionKey(sessionKey);
  } catch {
    return res.status(400).json({ error: 'invalid sessionKey' });
  }

  // Load config
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
    try {
      const resolvedBaseUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
      const response = await fetch(`${resolvedBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages: llmMessages, max_tokens: 4096 }),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: `LLM API error ${response.status}: ${err}` });
      }

      const data = await response.json();
      const fullText = data.choices?.[0]?.message?.content || '';
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

  const controller = new AbortController();

  req.on('close', () => {
    controller.abort();
    res.end();
  });

  (async () => {
    try {
      const resolvedBaseUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
      const response = await fetch(`${resolvedBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages: llmMessages, stream: true }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.text();
        res.write(`data: ${JSON.stringify({ type: 'error', error: `LLM API error ${response.status}` })}\n\n`);
        res.end();
        return;
      }

      if (!response.body) {
        res.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

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
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                res.write(`data: ${JSON.stringify({ type: 'text_delta', delta })}\n\n`);
              }
            } catch {}
          }
        }
      } finally {
        reader.releaseLock();
      }

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
    } catch (e: any) {
      if (e.name === 'AbortError') {
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
      res.end();
    }
  })();
});

export default router;