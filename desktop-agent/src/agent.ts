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

function buildStreamFn(baseUrl: string, apiKey: string) {
  const resolvedBaseUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
  const isAnthropic = resolvedBaseUrl.includes('anthropic') || resolvedBaseUrl.includes('.anthropic');

  return async function streamSimple(
    _model: any,  // model passed by agentLoop (overrides closure model if used)
    _ctx: { messages: any[]; signal?: AbortSignal } = { messages: [] }
  ): Promise<EventStream> {
    // Use model from _model (passed by agentLoop), not from closure
    const modelId = typeof _model === 'string' ? _model : (_model?.id || String(_model));
    const messages = _ctx.messages;
    const controller = new AbortController();
    if (_ctx.signal) {
      _ctx.signal.addEventListener('abort', () => controller.abort());
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method: 'POST', headers, signal: controller.signal as any };

    let url: string;
    let body: any;

    if (isAnthropic) {
      url = `${resolvedBaseUrl}/messages`;
      body = {
        model: modelId,
        messages: messages.filter((m: any) => m.role !== 'system'),
        system: messages.find((m: any) => m.role === 'system')?.content || '',
        stream: true,
        max_tokens: DEFAULT_MAX_TOKENS,
      };
    } else {
      url = `${resolvedBaseUrl}/chat/completions`;
      body = { model: modelId, messages, stream: true };
    }

    fetchOptions.body = JSON.stringify(body);

    console.error('DEBUG fetch start, body:', fetchOptions.body?.slice(0, 200));
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LLM API error ${response.status}: ${err}`);
    }

    if (!response.body) throw new Error('No response body');

    const stream = new EventStream(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => event.type === 'done' ? event.message : undefined
    );

    // Emit 'start' first so agentLoop can set partialMessage before text_delta arrives
    stream.push({
      type: 'start',
      partial: {
        role: 'assistant',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'unknown',
        timestamp: Date.now(),
      },
    });

    async function processStream() {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let messageText = '';

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
              // Will push done below after loop
              break;
            }

            try {
              console.error('DEBUG raw data:', JSON.stringify(data).slice(0, 100));
              const parsed = JSON.parse(data);

              if (isAnthropic) {
                if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta?.text || '';
                  if (delta) {
                    messageText += delta;
                    stream.push({ type: 'text_delta', delta, contentIndex: 0 });
                  }
                }
              } else {
                const choice = parsed.choices?.[0];
                if (!choice) continue;


                               if (choice.delta && 'content' in choice.delta) {
                  const delta = choice.delta.content;
                  if (delta) { messageText += delta; stream.push({ type: 'text_delta', delta, contentIndex: choice.index || 0 }); }
                }
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      } finally {
        // Push 'done' to resolve the EventStream result — AgentStream completes on agent_end,
        // not done, so this does not cause double-resolution (done resolves result, end() is no-op)
        stream.push({
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: messageText }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        });
      }
    }

    processStream().catch((e) => stream.push({ type: 'error', message: e.message }));

    return stream;
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

function buildAgentConfig(model: string, apiKey: string) {
  return {
    model,
    convertToLlm: (msgs: any[]) => msgs.map((m) => ({ role: m.role, content: m.content })),
    getApiKey: async () => apiKey,
  };
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
      const core = await getAgentCore();
      const streamFn = buildStreamFn(baseUrl, apiKey);
      const eventStream = await core.agentLoop(
        llmMessages,
        { messages: llmMessages },
        buildAgentConfig(model, apiKey),
        undefined,
        streamFn
      );
      for await (const _event of eventStream) {
        // consume iterator — agentLoop completes when agent_end is emitted
      }
      const result = await eventStream.result();
      const finalMsg = Array.isArray(result) ? result[result.length - 1] : result;
      console.error('DEBUG result:', JSON.stringify(result)?.slice(0, 200));
      const fullText = finalMsg?.content?.[0]?.text || '';
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

  // Streaming: SSE via agentLoop
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
      const core = await getAgentCore();
      const streamFn = buildStreamFn(baseUrl, apiKey);
      const eventStream = await core.agentLoop(
        llmMessages,
        { messages: llmMessages },
        buildAgentConfig(model, apiKey),
        controller.signal,
        streamFn
      );
      let lastText = '';
      for await (const event of eventStream) {
        if (event.type === 'message_update' && event.message?.content?.[0]?.text) {
          const fullText = event.message.content[0].text;
          const delta = fullText.slice(lastText.length);
          lastText = fullText;
          res.write(`data: ${JSON.stringify({ type: 'text_delta', delta })}\n\n`);
        }
        if (event.type === 'agent_end') {
          const assistantMsg: AgentMessage = {
            id: uuid(),
            role: 'assistant',
            content: lastText,
            timestamp: Date.now(),
          };
          await appendMessage(sessionKey, userMsg);
          await appendMessage(sessionKey, assistantMsg);
                   res.write(`data: ${JSON.stringify({ type: 'message_end', content: lastText })}\n\n`);          res.end();
          return;
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}
\n`);
      res.end();
    }
  })();
});


export default router;