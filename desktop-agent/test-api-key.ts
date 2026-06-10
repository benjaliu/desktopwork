import { loadLLMConfig, resolveModel } from './src/llm.ts';

async function test() {
  const config = await loadLLMConfig('/tmp/debug-agent-data');
  console.log('Config keys:', Object.keys(config.providers));
  const provider = config.providers['baozun'];
  console.log('Provider:', JSON.stringify(provider));
  const model = resolveModel(config, 'qwen-plus', 'baozun');
  console.log('Model:', JSON.stringify(model));
  process.exit(0);
}

test();
