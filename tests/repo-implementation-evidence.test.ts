import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@arcanos/cli/client', () => ({
  invokeTool: jest.fn()
}));

const {
  shouldInspectRepoPrompt,
  isVerificationQuestion
} = await import('../src/services/repoImplementationEvidence.js');

describe('repo inspection prompt detection', () => {
  it('requires repo intent instead of matching generic backend language', () => {
    expect(shouldInspectRepoPrompt('What is the backend status right now?')).toBe(false);
    expect(shouldInspectRepoPrompt('Ping the backend and tell me if it is up.')).toBe(false);
  });

  it('keeps explicit repository inspection prompts routed to evidence mode', () => {
    expect(shouldInspectRepoPrompt('Is my CLI implemented?')).toBe(true);
    expect(shouldInspectRepoPrompt('Show me the repo status and changed files.')).toBe(true);
    expect(shouldInspectRepoPrompt('Inspect the codebase and list the protocol schemas.')).toBe(true);
  });

  it('does not hijack prompt-authoring requests that merely mention repo inspection', () => {
    expect(shouldInspectRepoPrompt('Create a prompt for Codex to inspect the repo and suggest fixes')).toBe(false);
    expect(shouldInspectRepoPrompt('Write a prompt template that inspects the codebase and lists protocol schemas')).toBe(false);
  });

  it('still marks explicit verification prompts as verification questions', () => {
    expect(isVerificationQuestion('What commands exist?')).toBe(true);
    expect(isVerificationQuestion('Can you see my codebase?')).toBe(true);
  });
});
