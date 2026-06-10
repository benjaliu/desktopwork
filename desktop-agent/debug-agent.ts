import { createAgent } from './src/agent.ts';

async function test() {
  const agent = await createAgent({
    dataDir: '/tmp/debug-agent-data',
    skillsDirs: []
  });
  
  console.log('Agent created, sending message...');
  try {
    const result = await agent.chat('Say hello in 3 words', 'test:debug');
    console.log('Result text:', result.text);
    console.log('Messages count:', result.messages.length);
    if (result.messages[0]) {
      const c = result.messages[0].content;
      console.log('Content:', JSON.stringify(c).slice(0, 100));
    }
  } catch(e) {
    console.error('Chat error:', e.message);
    console.error('Stack first line:', e.stack?.split('\n')[1]);
  }
  
  process.exit(0);
}

test();
