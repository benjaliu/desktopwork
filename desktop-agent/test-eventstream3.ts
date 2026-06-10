import { EventStream } from './vendor/bundles/llm-core.esm.js';

async function test() {
  const stream = new EventStream(
    (e) => e.type === 'done',
    (e) => e.message
  );

  // Simulate: push happens inside async function AFTER iterator starts
  stream.push({ type: 'start', partial: { id: '1', role: 'assistant', content: [] } });
  
  // Simulate readChunk that runs AFTER iterator starts
  const readChunk = async () => {
    await new Promise(r => setTimeout(r, 50)); // Simulate network delay
    console.log('[reader] pushing text_delta');
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Hello', partial: { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    await new Promise(r => setTimeout(r, 50));
    console.log('[reader] pushing done');
    stream.push({ type: 'done', message: { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    stream.end();
  };
  
  readChunk(); // Fire and forget - don't await!
  
  console.log('Starting iteration...');
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
