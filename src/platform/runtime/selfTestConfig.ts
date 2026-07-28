export interface SelfTestPrompt {
  id: string;
  prompt: string;
  expectation: string;
}

export const DEFAULT_SELF_TEST_PROMPTS: SelfTestPrompt[] = [
  {
    id: 'readiness',
    prompt: 'Respond with a concise status update proving ARCANOS is online and ready for work.',
    expectation: 'Model responds with operational readiness signal.'
  },
  {
    id: 'memory-awareness',
    prompt: 'Report only whether the memory subsystem is available. Do not quote, summarize, or reveal stored memory.',
    expectation: 'Model reports memory-subsystem availability without returning stored content.'
  },
  {
    id: 'module-routing',
    prompt: 'Which internal module handled this request? Reply in JSON {"module":"name"}.',
    expectation: 'Model identifies the executing module and formats JSON correctly.'
  }
];

export const SELF_TEST_USER_AGENT = 'arcanos-self-test/1.0';
