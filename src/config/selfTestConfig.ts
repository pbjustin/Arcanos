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
    prompt: 'Summarize any memory context you can access in one paragraph.',
    expectation: 'Model references stored memory context without errors.'
  },
  {
    id: 'module-routing',
    prompt: 'Which internal module handled this request? Reply in JSON {"module":"name"}.',
    expectation: 'Model identifies the executing module and formats JSON correctly.'
  }
];

export const SELF_TEST_USER_AGENT = 'arcanos-self-test/1.0';
