import { EventStream } from './vendor/bundles/llm-core.esm.js';
import { agentLoop } from './vendor/bundles/agent-core.esm.js';

const apiKey = 'bz-AAABm07VXlaxFWW2cJYGV6xVsZaa2z9fFb5BehmdKtrTtADo';
const baseUrl = 'https://aegis-higress-gateway.baozun.com';

function buildStreamFn() {
  return async function stream(model, context, options) {
    const s = new EventStream(
      (e) => e.type === 'done' || e.type === 'error',
      (e) => e.type === 'done' ? e.message : { errorMessage: String(e) }
    );

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen-plus',
        messages: context.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
        max_tokens: 20, stream: true
      })
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let partial = null;

    function detectEventType(data) {
      try {
        const obj = JSON.parse(data);
        const choice = obj.choices?.[0];
        if (choice?.finish_reason) return 'message_stop';
        if (choice?.delta?.content) return 'content_block_delta';
        if (choice?.delta?.tool_calls) return 'content_block_delta';
      } catch {}
      return '';
    }

    async function emitOpenAIChunk(dataStr, eventType) {
      console.log('emitOpenAIChunk called:', eventType, dataStr.slice(0, 60));
      try {
        const obj = JSON.parse(dataStr);
        const choice = obj.choices?.[0];
        if (!choice) { console.log('  no choice'); return; }
        if (eventType === 'content_block_delta') {
          if (choice.delta?.content) {
            const text = choice.delta.content;
            console.log('  text delta:', text);
            if (!partial) {
              partial = { id: obj.id || 'id', role: 'assistant', content: [], timestamp: Date.now() };
              s.push({ type: 'start', partial });
              console.log('  pushed start');
            }
            partial.content.push({ type: 'text', text });
            s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...partial } });
            console.log('  pushed text_delta, content now:', partial.content.length, 'items');
          }
        } else if (eventType === 'message_stop') {
          console.log('  message_stop, partial:', partial?.content?.length);
          partial.stopReason = choice.finish_reason || 'stop';
          s.push({ type: 'done', message: { ...partial } });
          s.end();
        }
      } catch(e) {
        console.log('  emitOpenAIChunk error:', e.message);
      }
    }

    const readChunk = async () => {
      const { done, value } = await reader.read();
      if (done) { console.log('reader done, buffer:', buffer.slice(0, 100)); return; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') {
          console.log('DONE marker');
          s.push({ type: 'done', message: partial });
          s.end();
          return;
        }
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          const eventType = detectEventType(data);
          console.log('parsed, eventType:', eventType, 'data:', data.slice(0, 60));
          if (eventType) await emitOpenAIChunk(data, eventType);
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
  const userMsg = { id: '1', role: 'user', content: 'Say hi', timestamp: Date.now() };
  
  console.log('Starting agentLoop...');
  const stream = agentLoop([userMsg], { systemPrompt: '', messages: [] }, { model, convertToLlm }, null, null, runtime);
  
  let fullText = '';
  let lastText = '';
  let count = 0;
  try {
    for await (const event of stream) {
      count++;
      if (event.type === 'text_delta' && event.delta) {
        fullText += event.delta;
        process.stdout.write(event.delta);
      }
    }
  } catch(e) {
    console.error('Error:', e.message);
  }
  console.log('\nTotal events:', count, 'fullText:', fullText);
}
test().catch(e => console.error('Fatal:', e.message));
