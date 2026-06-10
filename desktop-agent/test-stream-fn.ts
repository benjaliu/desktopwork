// Test buildStreamFn directly
import { buildStreamFn as origBuildStreamFn } from './src/agent.ts';

async function test() {
  // Access the internal buildStreamFn via the module
  const { createAgent } = await import('./src/agent.ts');
  
  // Monkey-patch buildStreamFn to add logging
  const agent = await createAgent({
    dataDir: '/tmp/test-agent-data',
    skillsDirs: []
  });
  
  // Intercept the stream by wrapping the runtime
  console.log('Testing streaming directly...');
  
  // Just test the API call directly
  const response = await fetch('https://aegis-higress-gateway.baozun.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer bz-AAABm07VXlaxFWW2cJYGV6xVsZaa2z9fFb5BehmdKtrTtADo',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'Say hi' }],
      max_tokens: 20,
      stream: true
    })
  });
  
  console.log('HTTP status:', response.status);
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let count = 0;
  
  const readChunk = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          console.log('DONE, total chunks:', count);
          return;
        }
        try {
          const obj = JSON.parse(data);
          const text = obj.choices?.[0]?.delta?.content;
          if (text) {
            count++;
            process.stdout.write(text);
          }
        } catch(e) {}
      }
    }
    if (!done) await readChunk();
  };
  
  await readChunk();
  console.log('\nTotal text chunks:', count);
  process.exit(0);
}

test().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
