import { createAgent } from './src/agent.ts';

async function test() {
  const agent = await createAgent({
    dataDir: '/tmp/debug-agent-data',
    skillsDirs: []
  });
  
  console.log('Agent created, sending message...');
  try {
    const result = await agent.chat('Say hello in 3 words', 'test:debug');
    console.log('Result text:', JSON.stringify(result.text));
    console.log('Messages count:', result.messages.length);
  } catch(e) {
    console.error('Chat error:', e.message);
  }
  
  process.exit(0);
}

test();
