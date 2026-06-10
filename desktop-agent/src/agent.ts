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

// convertToLlm: transform AgentMessage[] to LLM message format
// This is called by agentLoop internally — must be provided in config.
function convertToLlm(messages: AgentMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === 'user' || m.role === 'assistant') {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content as any[]).map((c: any) => c.text || '').join('');
      return { role: m.role, content };
    }
    return { role: 'user', content: String(m.content) };
  });
}

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
    console.error('[buildStreamFn] called, apiType:', apiType, 'baseUrl:', baseUrl);
    try {
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
      endpoint = `${baseUrl}/v1/chat/completions`;
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
          stream2.push({ type: 'text_delta', contentIndex: 0, delta: block.text, partial: { id: '', role: 'assistant', content: [{ type: 'text', text: block.text }], timestamp: Date.now() } });
        }
      }
      stream2.push({ type: 'done', message: { id: '', role: 'assistant', content: result.content, timestamp: Date.now(), stopReason: result.stopReason } });
      stream2.end();
      return stream2;
    }

    console.error('[buildStreamFn] about to fetch, endpoint:', endpoint, 'body keys:', Object.keys(requestBody));
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: options.signal
      });
    } catch(e) {
      console.error('[buildStreamFn] fetch threw:', e.message);
      throw e;
    }
    console.error('[buildStreamFn] fetch got response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      const errorStream = new EventStream(
        (event) => event.type === 'error',
        (event) => ({ errorMessage: event.message || String(event) })
      );
      errorStream.push({ type: 'error', message: `HTTP ${response.status}: ${errorText}` });
      errorStream.end();
      return errorStream;
    }

    console.error('[buildStreamFn] response.body exists:', !!response.body, 'type:', typeof response.body);
    const stream = new EventStream(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => event.type === 'done' ? event.message : { errorMessage: event.message || String(event) }
    );

    // Partial message accumulator for text_delta events
    let partialMessage: any = null;
    let eventCount = 0;
    const log = (msg: string) => console.error('[buildStreamFn]', msg);

    // Read SSE body
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readChunk = async (): Promise<void> => {
      console.error('[buildStreamFn] readChunk reading...');
      const { done, value } = await reader.read();
      console.error('[buildStreamFn] read done=', done, 'valueLen=', value?.length);
      if (done) {
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
        const parsed = parseSseLine(line);
        if (!parsed) continue;

        if (parsed.type === '_done') {
          // Stream end marker
          await emitEvent({ type: 'message_stop', data: '' });
          continue;
        }

        if (parsed.type === 'data') {
          // Check if this is OpenAI format (no `event:` prefix) or Anthropic format
          const eventType = detectOpenAIEventType(parsed.data);
          if (eventType) {
            // OpenAI format — data IS the JSON, emit directly
            await emitOpenAIChunk(parsed.data, eventType);
          } else {
            // Anthropic format — buffer contains event type from previous line
            const event = parseSseEvent(parsed.data);
            if (event) await emitEvent(event);
          }
        }
      }

      if (!done) {
        await readChunk();;
      }
    };

    // Parse OpenAI SSE: `data: {...json...}` or Anthropic: `event: type\ndata: {...}`
    function parseSseLine(line: string): { type: string; data: string } | null {
      if (line === 'data: [DONE]') {
        return { type: '_done', data: '' };
      }
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

    // Detect event type from OpenAI chunk JSON (fallback when no `event:` prefix)
    function detectOpenAIEventType(data: string): string {
      try {
        const obj = JSON.parse(data);
        const choice = obj.choices?.[0];
        // Check delta FIRST — content_block_delta may coexist with finish_reason in same chunk
        if (choice?.delta) {
          if (choice.delta.content) return 'content_block_delta';
          if (choice.delta.tool_calls) return 'content_block_delta';
        }
        if (choice?.finish_reason) return 'message_stop';
      } catch {}
      return '';
    }

    // Emit event from Anthropic SSE format (event: type\ndata: {...})
    async function emitEvent(event: { type: string; data: string }): Promise<void> {
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
          partialMessage.content.push({ type: 'text', text });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...partialMessage } });
        }
      } else if (event.type === 'message_delta') {
        const data = JSON.parse(event.data);
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

    // Emit event from OpenAI SSE format (data: {...json...} without event: prefix)
    async function emitOpenAIChunk(dataStr: string, eventType: string): Promise<void> {
      console.error('[buildStreamFn] emitOpenAIChunk called, eventType:', eventType, 'dataLen:', dataStr.length);
      try {
        const obj = JSON.parse(dataStr);
        const choice = obj.choices?.[0];
        if (!choice) return;


        // Always process content_block_delta FIRST (may coexist with message_stop in same chunk)
        if (choice.delta?.content) {
          const text = choice.delta.content;
          if (!partialMessage) {
            partialMessage = {
              id: obj.id || crypto.randomUUID(),
              role: 'assistant',
              content: [],
              timestamp: Date.now()
            };
            console.error('[buildStreamFn] PUSHING START, queue len before:', (stream as any).queue.length);
            stream.push({ type: 'start', partial: partialMessage });
            console.error('[buildStreamFn] PUSHED START, queue len after:', (stream as any).queue.length);
          }
          partialMessage.content.push({ type: 'text', text });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...partialMessage } });
        } else if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            partialMessage.content.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.function?.arguments });
          }
        }
        // Then process message_stop (finish_reason) if present — may be in same chunk as content_block_delta
        if (choice.finish_reason) {
          partialMessage.stopReason = choice.finish_reason || 'stop';
          console.error('[buildStreamFn] DONE, partialMessage.content:', JSON.stringify(partialMessage?.content));
          (stream as any).finalText = partialMessage.content.map((c: any) => c.text || '').join('');
          stream.push({ type: 'done', message: { ...partialMessage } });
        }
      } catch (e) {
        // Ignore parse errors for non-JSON lines
      }
    }

    await readChunk();
    // Do NOT call stream.end() here — the done event is already in the queue.
    // The for-await loop will drain the queue and exit when it yields the done event.
    console.error('[buildStreamFn] readChunk done, returning stream, queue len:', (stream as any).queue.length, 'done:', (stream as any).done);
        } catch(err) {
      console.error('[buildStreamFn] stream function error:', err.message, err.stack?.split('\n').slice(0,5).join(' | '));
      const errorStream = new EventStream(
        (event) => event.type === 'error',
        (event) => ({ errorMessage: String(event) })
      );
      errorStream.push({ type: 'error', message: err.message });
      errorStream.end();
      return errorStream;
    }
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

  // Note: streamFn is passed as runtime.streamSimple to the bundle

  // Runtime for agent-core
  const runtime = {
    completeSimple: completeFn,
    streamSimple: streamFn
  };

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
    // config must have convertToLlm (called by streamAssistantResponse internally)
    const stream = loop(prompts, context, { model, convertToLlm }, null, null, runtime);

    let fullText = '';
    let finalMessages: AgentMessage[] = [];

    // Collect stream events via async iterator
    let lastText = '';
    try {
      for await (const event of stream as any) {
        console.error('[agent] stream event:', event.type, 'delta:', event.delta, 'msgtype:', event.message?.content?.[0]?.text ? 'hastext' : 'notext');
        // Support both OpenAI streaming (text_delta directly) and Anthropic (wrapped in message_update)
        const isTextDelta = event.type === 'text_delta' || (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta');
        if (isTextDelta) {
          const delta = event.delta || event.assistantMessageEvent?.delta;
          if (delta) {
            console.error('[agent] adding delta:', delta.slice(0, 20));
            fullText += delta;
            onDelta?.(delta);
          }
        }
        if (event.type === 'message_end' && event.message) {
          finalMessages = [event.message as AgentMessage];
          // If fullText is empty (e.g. all content came through done event), extract from message
          if (!fullText && (event.message as any).content) {
            const content = (event.message as any).content;
            if (Array.isArray(content)) {
              fullText = content.map((c: any) => c.text || '').join('');
            }
          }
        }
        // Handle done event: extract accumulated text from event.message (partialMessage)
        if (event.type === 'done' && !fullText) {
          const msgContent = (event as any).message?.content;
          if (Array.isArray(msgContent)) {
            fullText = msgContent.map((c: any) => c.text || '').join('');
          }
        }
      }
    } catch(err) {
      console.error('[agent] stream error:', err.message, err.stack?.split('\n').slice(0,3).join(' | '));
    } finally {
      // ensure stream ends
      if (!stream.done) {
        stream.end();
      }
    }

    // Last resort: if fullText is still empty, try stream.finalText (set by buildStreamFn when done event is pushed)
    if (!fullText) {
      fullText = (stream as any).finalText || '';
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