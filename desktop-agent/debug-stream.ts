// Add debug logging to buildStreamFn inline test
import { EventStream } from './vendor/bundles/llm-core.esm.js';

const apiKey = 'bz-AAABm07VXlaxFWW2cJYGV6xVsZaa2z9fFb5BehmdKtrTtADo';
const baseUrl = 'https://aegis-higress-gateway.baozun.com';

async function test() {
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'Say hi' }],
      max_tokens: 20, stream: true
    })
  });

  const stream = new EventStream(
    (e) => e.type === 'done' || e.type === 'error',
    (e) => e.type === 'done' ? e.message : { errorMessage: String(e) }
  );

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

  function emitChunk(data, eventType) {
    console.log('EMIT_CHUNK:', eventType, data.slice(0, 80));
    const obj = JSON.parse(data);
    const choice = obj.choices?.[0];
    if (eventType === 'content_block_delta' && choice?.delta?.content) {
      const text = choice.delta.content;
      if (!partial) {
        partial = { id: obj.id||'id', role: 'assistant', content: [], timestamp: Date.now() };
        stream.push({ type: 'start', partial });
      }
      partial.content.push({ type: 'text', text });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...partial } });
    } else if (eventType === 'message_stop') {
      partial.stopReason = choice.finish_reason || 'stop';
      stream.push({ type: 'done', message: { ...partial } });
      stream.end();
    }
  }

  const readChunk = async () => {
    const { done, value } = await reader.read();
    if (done) {
      console.log('Reader done, buffer:', buffer.slice(0, 100));
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === 'data: [DONE]') {
        console.log('DONE marker');
        stream.push({ type: 'done', message: partial });
        stream.end();
        return;
      }
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        const eventType = detectEventType(data);
        console.log('Parsed line, eventType:', eventType, 'data:', data.slice(0, 60));
        if (eventType) emitChunk(data, eventType);
      }
    }
    if (!done) await readChunk();
  };

  await readChunk();

  let fullText = '';
  for await (const event of stream) {
    console.log('Stream event:', event.type);
    if (event.type === 'text_delta') {
      fullText += event.delta;
      console.log('  delta:', event.delta);
    }
  }
  console.log('Final text:', fullText);
}

test().catch(e => console.error('Fatal:', e.message));
