import { EventStream } from './vendor/bundles/llm-core.esm.js';

async function test() {
  const stream = new EventStream(
    (e) => e.type === 'done',
    (e) => e.message
  );

  stream.push({ type: 'start', partial: { id: '1', role: 'assistant', content: [] } });
  
  // Simulate: return stream immediately, readChunk runs later
  const readChunk = async () => {
    await new Promise(r => setTimeout(r, 50));
    console.log('[reader] pushing text_delta');
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Hello', partial: { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    await new Promise(r => setTimeout(r, 50));
    console.log('[reader] pushing done');
    stream.push({ type: 'done', message: { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    stream.end();
  };
  
  // Start iteration BEFORE readChunk
  const iterPromise = (async () => {
    console.log('Starting iteration...');
    let count = 0;
    for await (const event of stream) {
      console.log('Iterator got event:', event.type, 'delta:', event.delta);
      count++;
      if (count > 10) break;
    }
    console.log('Total events:', count);
  })();
  
  // Now start readChunk (don't await)
  readChunk();
  
  await iterPromise;
  process.exit(0);
}

test();
