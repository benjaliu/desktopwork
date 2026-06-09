import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { EventStream } from '../vendor/bundles/llm-core.esm.js';
import type {
  AgentMessage,
  agentLoop,
  loadSkills
} from '../vendor/bundles/agent-core.esm.js';
import { loadLLMConfig, resolveModel, type ModelConfig, type LLMCompleteOptions, type LLMResponse } from './llm.js';
import { createSessionStore, type SessionStore } from './session.js';

export interface AgentConfig {
  dataDir: string;
  skillsDirs: string[];
}

export interface ChatResult {
  text: string;
  messages: AgentMessage[];
}

export interface Agent {
  chat(message: string, sessionKey: string, onDelta?: (delta: string) => void): Promise<ChatResult>;
  shutdown(): Promise<void>;
}

// Node.js fs abstraction for JsonlSessionStorage
const nodeFs = {
  async readTextFile(path: string): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { readFileSync } = require('node:fs');
      return { ok: true, value: readFileSync(path, 'utf-8') };
    } catch (e: any) {
      if (e.code === 'ENOENT') return { ok: false, error: { code: 'not_found', message: e.message } };
      return { ok: false, error: { code: 'read_error', message: e.message } };
    }
  },
  async writeFile(path: string, content: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { writeFileSync, mkdirSync } = require('node:fs');
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content, 'utf-8');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: { code: 'write_error', message: e.message } };
    }
  },
  async appendFile(path: string, content: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { appendFileSync } = require('node:fs');
      appendFileSync(path, content, 'utf-8');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: { code: 'append_error', message: e.message } };
    }
  },
  async absolutePath(path: string): Promise<{ ok: true; value: string }> {
    return { ok: true, value: path };
  },
  async joinPath(parts: string[]): Promise<{ ok: true; value: string }> {
    return { ok: true, value: join(...parts) };
  },
  async fileInfo(path: string): Promise<{ ok: true; value: { isDirectory: boolean } } | { ok: false; error: { code: string; message: string } }> {
    return { ok: true, value: { isDirectory: existsSync(path) } };
  },
  async readDir(path: string): Promise<{ ok: true; value: string[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { readdirSync } = require('node:fs');
      return { ok: true, value: readdirSync(path) };
    } catch (e: any) {
      return { ok: false, error: { code: 'read_dir_error', message: e.message } };
    }
  }
};

// Build LLM complete function based on provider API type
function buildCompleteFn(model: ModelConfig, apiType: string, apiKey: string, baseUrl: string) {
  return async function complete(
    model: ModelConfig,
    context: { systemPrompt: string; messages: AgentMessage[] },
    options: LLMCompleteOptions
  ): Promise<LLMResponse> {
    const key = apiKey || options.apiKey || '';
    const headers: Record<string, string> = {
      ...(options.headers || {}),
      'Content-Type': 'application/json'
    };
    if (key) {
      if (apiType === 'anthropic-messages') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else if (apiType === 'openai-responses' || apiType === 'openai-chat') {
        headers['Authorization'] = `Bearer ${key}`;
      }
    }

    let endpoint = '';
    let requestBody: any = {};

    if (apiType === 'anthropic-messages') {
      endpoint = `${baseUrl}/v1/messages`;
      const msgs = context.messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'user',
        content: typeof m.content === 'string' ? m.content : (m.content as any[]).map(c => c.text || '').join('')
      }));
      requestBody = {
        model: model.id,
        messages: msgs,
        max_tokens: options.maxTokens || model.maxTokens || 4096
      };
      if (context.systemPrompt) {
        requestBody.system = context.systemPrompt;
      }
    } else if (apiType === 'openai-responses') {
      endpoint = `${baseUrl}/responses`;
      requestBody = {
        model: model.id,
        input: context.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : (m.content as any[]).map(c => c.text || '').join('')
        }))
      };
      if (context.systemPrompt) {
        requestBody.instructions = context.systemPrompt;
      }
    } else if (apiType === 'openai-chat') {
      endpoint = `${baseUrl}/chat/completions`;
      requestBody = {
        model: model.id,
        messages: [
          ...(context.systemPrompt ? [{ role: 'system' as const, content: context.systemPrompt }] : []),
          ...context.messages.map(m => ({
            role: m.role as string,
            content: typeof m.content === 'string' ? m.content : (m.content as any[]).map(c => c.text || '').join('')
          }))
        ]
      };
    } else if (apiType === 'ollama') {
      endpoint = `${baseUrl}/api/chat`;
      requestBody = {
        model: model.id,
        messages: [
          ...(context.systemPrompt ? [{ role: 'system' as const, content: context.systemPrompt }] : []),
          ...context.messages.map(m => ({
            role: m.role as string,
            content: typeof m.content === 'string' ? m.content : (m.content as any[]).map(c => c.text || '').join('')
          }))
        ]
      };
    } else {
      throw new Error(`Unsupported API type: ${apiType}`);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: options.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        stopReason: 'error',
        content: [],
        errorMessage: `HTTP ${response.status}: ${errorText}`
      };
    }

    const data = await response.json() as any;

    // Parse response based on API type
    if (apiType === 'anthropic-messages') {
      const content = data.content || [];
      return {
        stopReason: data.stop_reason || 'end_turn',
        content: content.map((c: any) => ({ type: c.type, text: c.text })),
        usage: data.usage ? {
          input: data.usage.input_tokens || 0,
          output: data.usage.output_tokens || 0,
          cacheRead: data.usage.cache_read_input_tokens || 0,
          cacheWrite: data.usage.cache_creation_output_tokens || 0,
          totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
        } : undefined
      };
    } else if (apiType === 'openai-responses') {
      const output = data.output || [];
      return {
        stopReason: data.status || 'completed',
        content: output.map((c: any) => ({ type: c.type, text: c.content?.[0]?.text || '' }))
      };
    } else if (apiType === 'openai-chat') {
      const choice = data.choices?.[0];
      return {
        stopReason: choice?.finish_reason || 'stop',
        content: choice?.message?.content ? [{ type: 'text', text: choice.message.content }] : []
      };
    } else if (apiType === 'ollama') {
      const msg = data.message || {};
      return {
        stopReason: data.done ? 'stop' : 'ongoing',
        content: [{ type: 'text', text: msg.content || '' }]
      };
    }

    return { stopReason: 'stop', content: [] };
  };
}

// Build LLM streaming function based on provider API type
function buildStreamFn(model: ModelConfig, apiType: string, apiKey: string, baseUrl: string) {
  return async function stream(
    model: ModelConfig,
    context: { systemPrompt: string; messages: AgentMessage[] },
    options: LLMCompleteOptions
  ): Promise<EventStream> {
    console.error('[buildStreamFn] called! apiType:', apiType, 'model:', model.id);
    const key = apiKey || options.apiKey || '';
    const headers: Record<string, string> = {
      ...(options.headers || {}),
      'Content-Type': 'application/json'
    };
    if (key) {
      if (apiType === 'anthropic-messages') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else if (apiType === 'openai-responses' || apiType === 'openai-chat') {
        headers['Authorization'] = `Bearer ${key}`;
      }
    }

    let endpoint = '';
    let requestBody: any = {};

    if (apiType === 'anthropic-messages') {
      endpoint = `${baseUrl}/v1/messages`;
      const msgs = context.messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'user',
        content: typeof m.content === 'string' ? m.content : (m.content as any[]).map(c => c.text || '').join('')
      }));
      requestBody = {
        model: model.id,
        messages: msgs,
        max_tokens: options.maxTokens || model.maxTokens || 4096,
        stream: true
      };
      if (context.systemPrompt) {
        requestBody.system = context.systemPrompt;
      }
    } else if (apiType === 'openai-chat') {
      endpoint = `${baseUrl}/chat/completions`;
      requestBody = {
        model: model.id,
        messages: [
          ...(context.systemPrompt ? [{ role: 'system' as const, content: context.systemPrompt }] : []),
          ...context.messages.map(m => ({
            role: m.role as string,
            content: typeof m.content === 'string' ? m.content : (m.content as any[]).map(c => c.text || '').join('')
          }))
        ],
        stream: true
      };
    } else {
      // Fallback: use non-streaming
      const result = await buildCompleteFn(model, apiType, apiKey, baseUrl)(model, context, options);
      const stream2 = new EventStream(
        (event) => event.type === 'done' || event.type === 'error',
        (event) => event.type === 'done' ? result : { errorMessage: String(event) }
      );
      stream2.push({ type: 'start', partial: { id: '', role: 'assistant', content: result.content, timestamp: Date.now() } });
      for (const block of result.content) {
        if (block.text) {
          stream2.push({ type: 'text_delta', partial: { id: '', role: 'assistant', content: [{ type: 'text', text: block.text }], timestamp: Date.now() } });
        }
      }
      stream2.push({ type: 'done', message: { id: '', role: 'assistant', content: result.content, timestamp: Date.now(), stopReason: result.stopReason } });
      stream2.end();
      return stream2;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: options.signal
    });

    console.error('[buildStreamFn] response status:', response.status, 'apiType:', apiType);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[buildStreamFn] error:', response.status, errorText.slice(0, 200));
      const errorStream = new EventStream(
        (event) => event.type === 'error',
        (event) => ({ errorMessage: event.message || String(event) })
      );
      errorStream.push({ type: 'error', message: `HTTP ${response.status}: ${errorText}` });
      errorStream.end();
      return errorStream;
    }

    const stream = new EventStream(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => event.type === 'done' ? event.message : { errorMessage: event.message || String(event) }
    );

    // Partial message accumulator for text_delta events
    let partialMessage: any = null;

    // Read SSE body
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readChunk = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) {
        // Process any remaining buffer
        if (buffer.trim()) {
          const event = parseSseEvent(buffer);
          if (event) await emitEvent(event);
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const event = parseSseLine(line);
        if (event) await emitEvent(event);
      }

      if (!done) {
        await readChunk();
      }
    };

    function parseSseLine(line: string): { type: string; data: string } | null {
      if (!line.startsWith('event:') && !line.startsWith('data:')) return null;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) return null;
      const type = line.slice(0, colonIdx).trim();
      const data = line.slice(colonIdx + 1).trim();
      return { type, data };
    }

    function parseSseEvent(buffer: string): { type: string; data: string } | null {
      let eventType = '';
      let eventData = '';
      for (const line of buffer.split('\n')) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;
        if (parsed.type === 'event') eventType = parsed.data;
        if (parsed.type === 'data') eventData = parsed.data;
      }
      return eventType ? { type: eventType, data: eventData } : null;
    }

    async function emitEvent(event: { type: string; data: string }): Promise<void> {
      console.error('[buildStreamFn] emitEvent:', event.type, event.data?.slice(0, 100));
      if (event.type === 'message_start') {
        const data = JSON.parse(event.data);
        partialMessage = {
          id: data.message?.id || crypto.randomUUID(),
          role: 'assistant',
          content: data.message?.content || [],
          timestamp: Date.now()
        };
        stream.push({ type: 'start', partial: partialMessage });
      } else if (event.type === 'content_block_delta') {
        const data = JSON.parse(event.data);
        if (data.type === 'text_delta') {
          const text = data.text;
          // Append text block to partial message
          partialMessage.content.push({ type: 'text', text });
          stream.push({ type: 'text_delta', partial: { ...partialMessage } });
        }
      } else if (event.type === 'message_delta') {
        const data = JSON.parse(event.data);
        // Update partial message with final delta info
        if (data.usage) {
          partialMessage.usage = data.usage;
        }
        if (data.type === 'message_delta' && data.delta) {
          partialMessage.stopReason = data.delta.stop_reason;
        }
      } else if (event.type === 'message_stop') {
        stream.push({
          type: 'done',
          message: { ...partialMessage }
        });
        stream.end();
      }
    }

    await readChunk();
    return stream;
  };
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  // Load LLM config
  const llmConfig = loadLLMConfig();
  const model = resolveModel(llmConfig);
  const provider = llmConfig.providers[llmConfig.activeProvider];

  console.error('[agent] Model:', model.id, 'Provider:', model.provider, 'API:', model.api);

  // Create session store
  const sessionsPath = join(config.dataDir, 'sessions');
  const sessionStore = createSessionStore(sessionsPath);

  // Build complete function
  const completeFn = buildCompleteFn(model, provider.api, provider.apiKey || '', provider.baseUrl);
  const streamFn = buildStreamFn(model, provider.api, provider.apiKey || '', provider.baseUrl);
  console.error('[agent] streamFn defined:', typeof streamFn);

  // Wrap streamFn to detect calls
  const wrappedStreamFn = async function(model: ModelConfig, context: any, options: any) {
    console.error('[agent] wrappedStreamFn called!');
    return streamFn(model, context, options);
  };

  // Runtime for agent-core
  const runtime = {
    completeSimple: completeFn,
    streamSimple: wrappedStreamFn
  };
  console.error('[agent] runtime.streamSimple:', typeof runtime.streamSimple, '===streamFn:', runtime.streamSimple === streamFn);

  // Proxy to detect streamSimple access
  const runtimeProxy = new Proxy(runtime, {
    get(target, prop) {
      console.error('[agent] runtime proxy get:', String(prop));
      return target[prop];
    }
  });
  console.error('[agent] runtimeProxy.streamSimple:', typeof runtimeProxy.streamSimple);

  function extractText(msg: { content: unknown }): string {
    if (!msg.content) return '';
    if (typeof msg.content === 'string') return msg.content;
    return (msg.content as any[]).map(c => c.text || '').join('');
  }

  async function chat(message: string, sessionKey: string, onDelta?: (delta: string) => void): Promise<ChatResult> {
    // Load session history
    const history = await sessionStore.getMessages(sessionKey);

    // Build prompt messages
    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now()
    };

    const prompts = [userMsg];
    const context = {
      systemPrompt: '',
      messages: history
    };

    // Import agentLoop
    const { agentLoop: loop } = await import('../vendor/bundles/agent-core.esm.js');

    // Run agent loop
    const stream = loop(prompts, context, { model }, null, null, runtimeProxy);

    let fullText = '';
    let finalMessages: AgentMessage[] = [];

    // Collect stream events via async iterator
    let lastText = '';
    let eventCount = 0;
    try {
      for await (const event of stream as any) {
        eventCount++;
        console.error('[agent] event:', event.type, eventCount);
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          const currentText = extractText(event.message);
          if (currentText.startsWith(lastText)) {
            const delta = currentText.slice(lastText.length);
            if (delta) {
              fullText += delta;
              onDelta?.(delta);
              console.error('[agent] delta:', JSON.stringify(delta));
            }
          }
          lastText = currentText;
        }
        if (event.type === 'message_end' && event.message) {
          finalMessages = [event.message as AgentMessage];
          console.error('[agent] message_end, text:', JSON.stringify(extractText(event.message)));
        }
      }
      console.error('[agent] stream ended, eventCount:', eventCount, 'fullText:', JSON.stringify(fullText));
    } catch (e: any) {
      console.error('[agent] stream error:', e.message);
    } finally {
      // ensure stream ends
      if (!stream.done) {
        stream.end();
        console.error('[agent] stream.force ended');
      }
    }

    // Save messages to session
    await sessionStore.appendMessage(sessionKey, userMsg);
    if (finalMessages.length > 0) {
      await sessionStore.appendMessage(sessionKey, finalMessages[0]);
    }

    return { text: fullText, messages: finalMessages };
  }

  async function shutdown(): Promise<void> {
    console.error('[agent] Shutdown');
  }

  return { chat, shutdown };
}