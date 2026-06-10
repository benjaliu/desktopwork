import { EventStream } from './vendor/bundles/llm-core.esm.js';

async function test() {
  const stream = new EventStream(
    (e) => e.type === 'done',
    (e) => e.message
  );

  // Push some events
  stream.push({ type: 'start', partial: { id: '1', role: 'assistant', content: [] } });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Hello', partial: { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: ' world', partial: { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] } });
  
  console.log('Queue after pushes:', (stream as any).queue.length, 'done:', (stream as any).done);

  // Start iterating
  const iterator = stream[Symbol.asyncIterator]();
  console.log('Starting iteration...');
  
  let count = 0;
  for await (const event of stream) {
    console.log('Iterator got event:', event.type, 'delta:', event.delta);
    count++;
    if (count > 5) break;
  }
  
  console.log('Total events:', count);
  process.exit(0);
}

test();
