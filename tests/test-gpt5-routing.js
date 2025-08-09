import { runThroughBrain } from '../dist/logic/trinity.js';

class MockOpenAI {
  constructor() {
    this.call = 0;
    this.chat = { completions: { create: this.create.bind(this) } };
    this.models = { retrieve: async () => ({ id: 'mock-model' }) };
  }

  async create(params) {
    this.call++;
    const id = `mock-${this.call}`;
    const created = Date.now();
    let content;
    if (this.call === 1 || this.call === 4) {
      // ARCANOS intake for each run
      content = `Framed:${params.messages[1].content}`;
    } else if (this.call === 2 || this.call === 5) {
      // GPT-5 reasoning
      content = `Analysis:${params.messages[1].content}`;
    } else if (this.call === 3 || this.call === 6) {
      // ARCANOS final
      content = `Final:${params.messages[2].content}`;
    } else {
      content = 'shadow';
    }
    return {
      id,
      created,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }
}

async function runTests() {
  const client = new MockOpenAI();

  const simple = await runThroughBrain(client, 'hello world');
  console.log('Simple routing:', simple.routingStages.join(' -> '));

  const complex = await runThroughBrain(client, 'explain quantum mechanics step by step');
  console.log('Complex routing:', complex.routingStages.join(' -> '));

  if (!simple.gpt5Used || !complex.gpt5Used) {
    throw new Error('gpt5Used flag not set');
  }
  if (!simple.routingStages.includes('GPT5-REASONING') || !complex.routingStages.includes('GPT5-REASONING')) {
    throw new Error('GPT5-REASONING stage missing');
  }

  console.log('\n✅ GPT-5 routing test passed');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
