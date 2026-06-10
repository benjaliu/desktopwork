import { EventStream } from './vendor/bundles/llm-core.esm.js';

async function test() {
  const stream = new EventStream(
    (e) => e.type === 'done',
    (e) => e.message
  );

  stream.push({ type: 'start', partial: { id: '1', role: 'assistant', content: [] } });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Hello', partial: { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
  console.log('Before end, queue len:', (stream as any).queue.length);
  
  stream.end({ id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop' });
  console.log('After end, queue len:', (stream as any).queue.length, 'done:', (stream as any).done);
  
  let count = 0;
  for await (const event of stream) {
    console.log('Iterator got event:', event.type, 'delta:', event.delta);
    count++;
    if (count > 10) break;
  }
  
  console.log('Total events:', count);
  process.exit(0);
}

test();
