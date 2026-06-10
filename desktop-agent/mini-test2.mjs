import { agentLoop } from './vendor/bundles/agent-core.esm.js';

const apiKey = 'bz-AAABm07VXlaxFWW2cJYGV6xVsZaa2z9fFb5BehmdKtrTtADo';
const baseUrl = 'https://aegis-higress-gateway.baozun.com';

function buildStreamFn() {
  return async function stream(model, context, options) {
    const { EventStream } = await import('./vendor/bundles/llm-core.esm.js');
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen-plus',
        messages: context.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
        max_tokens: 50, stream: true
      })
    });
    const s = new EventStream(
      (e) => e.type === 'done' || e.type === 'error',
      (e) => e.type === 'done' ? e.message : { errorMessage: String(e) }
    );
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let partial = null;
    const readChunk = async () => {
      const { done, value } = await reader.read();
      if (done) {
        s.push({ type: 'done', message: partial });
        s.end(); return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') { s.push({ type: 'done', message: partial }); s.end(); return; }
          try {
            const obj = JSON.parse(data);
            const text = obj.choices?.[0]?.delta?.content;
            if (text) {
              if (!partial) { partial = { id: obj.id||'id', role: 'assistant', content: [], timestamp: Date.now() }; s.push({ type: 'start', partial }); }
              partial.content.push({ type: 'text', text });
              s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...partial } });
            }
          } catch(e) {}
        }
      }
      if (!done) await readChunk();
    };
    await readChunk();
    return s;
  };
}

function convertToLlm(messages) {
  return messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }));
}

async function test() {
  const runtime = { streamSimple: buildStreamFn() };
  const model = { id: 'qwen-plus', provider: 'baozun' };
  const userMsg = { id: '1', role: 'user', content: 'Say hello', timestamp: Date.now() };
  console.log('Starting...');
  const stream = agentLoop([userMsg], { systemPrompt: '', messages: [] }, { model, convertToLlm }, null, null, runtime);
  let count = 0;
  try {
    for await (const event of stream) {
      count++;
      console.log(`Event ${count}:`, JSON.stringify(event).slice(0,150));
    }
  } catch(e) {
    console.error('Error:', e.message);
  }
  console.log('Total events:', count, 'done:', stream.done);
}
test().catch(e => console.error('Fatal:', e.message));
