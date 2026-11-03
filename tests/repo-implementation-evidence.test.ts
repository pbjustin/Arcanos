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

  it.each([
    'Explain what ARCANOS can help me do in two short sentences. Do not claim knowledge of your deployed Git revision unless it is verified.',
    'What can ARCANOS help me do? Do not guess the deployed Git revision.',
    'Explain what ARCANOS can help me do; do not claim knowledge of the deployed Git revision.'
  ])('does not combine a conversation request with an unrelated revision disclaimer: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(false);
  });

  it('keeps explicit repository inspection prompts routed to evidence mode', () => {
    expect(shouldInspectRepoPrompt('Is my CLI implemented?')).toBe(true);
    expect(shouldInspectRepoPrompt('Show me the repo status and changed files.')).toBe(true);
    expect(shouldInspectRepoPrompt('Inspect the codebase and list the protocol schemas.')).toBe(true);
    expect(shouldInspectRepoPrompt('Show me the Git status. Do not claim knowledge of your deployed Git revision unless it is verified.')).toBe(true);
    expect(shouldInspectRepoPrompt('Which files\nare in the repository?')).toBe(true);
    expect(shouldInspectRepoPrompt('Inspect the codebase; list the protocol schemas.')).toBe(true);
  });

  it.each([
    'Where is the package.json file?',
    'Where is the src/app.ts file?',
    'Please locate the config.production.json file.'
  ])('keeps filename periods inside an inspection request: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(true);
  });

  it.each([
    'This is my repository. Please inspect it.',
    'Here is my codebase. Please check it.'
  ])('recognizes an explicit inspection of the immediately preceding repository: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(true);
  });

  it.each(['\n', '\r\n', '\r'])(
    'keeps a numbered repository list attached to its inspection request with %j line endings', (newline) => {
      expect(shouldInspectRepoPrompt(`Inspect the following:${newline}1. repository files${newline}2. CLI commands`))
        .toBe(true);
      expect(shouldInspectRepoPrompt(`Inspect the following:${newline}1. weather${newline}2. recipes`))
        .toBe(false);
    }
  );

  it.each(['\n', '\r\n', '\r'])(
    'ends a negated check before a new affirmative inspection with %j line endings', (newline) => {
      expect(shouldInspectRepoPrompt(`Do not check the deployed Git revision${newline}Inspect the repository files`))
        .toBe(true);
      expect(shouldInspectRepoPrompt(`Do not check the deployed Git revision${newline}Do not inspect the repository files`))
        .toBe(false);
    }
  );

  it.each([
    'Do not read the repository files but show me its status',
    "Don't read the repository files but show me its status",
    'Do not read the repository files, but check their status'
  ])('retains a repository antecedent for an affirmative possessive status request: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(true);
  });

  it.each([
    'Do not read the repository files but show me that recipe',
    'Do not read the repository files but show me your status',
    'Do not read the repository files but do not show me its status',
    'Do not read the repository files. Show me its status'
  ])('does not reuse a negated repository target for a different or negated request: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(false);
  });

  it.each([
    'What can ARCANOS help me do? Do not check the deployed Git revision.',
    "What can ARCANOS help me do? Don't check the deployed Git revision.",
    'What can ARCANOS help me do? Don’t verify the deployed Git revision.',
    'Do not inspect the repository.',
    "Don't verify whether my CLI is implemented.",
    'This is my repository. Please do not inspect it.'
  ])('does not treat a negated inspection as an inspection request: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(false);
  });

  it.each([
    'Do not inspect the repository, its files, or Git status.',
    "Don't inspect the repository, its files, and CLI commands.",
    'Never check repository files, Git status, or available tools.',
    'Do not inspect the repository, including Git status and protocol schemas.',
    'What can ARCANOS help me do? Do not inspect the repository, its files, or Git status.',
    'Do not inspect the repository, its files, or Git status, but show me that recipe.',
    'Do not inspect the repository, show me the weather.',
    'Do not inspect the repository, what is the weather?',
    'Do not inspect the repository, do not check the weather, but show me its status',
    'Do not inspect the repository, never check the weather, but show me its status',
    'Do not inspect the repository, the weather, but show me its status'
  ])('keeps comma-separated prohibited targets out of repository intent: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(false);
  });

  it.each([
    'Do not check the deployed Git revision, but inspect the repository files.',
    "Don't check the deployed Git revision but inspect the repository files.",
    'Do not check the deployed Git revision, inspect the repository files.',
    'Do not check the deployed Git revision, please list the repository files.',
    'Do not check the deployed Git revision, which repository files exist?',
    'Do not inspect the Git history, where is the package.json file?',
    'Do not inspect the Git history, what commands exist?',
    'Do not inspect the Git history, is my CLI implemented?',
    'Do not inspect the Git history, are repository files missing?',
    'Do not inspect the Git history, do I have a CLI?',
    'Do not inspect the Git history, can you see my codebase?',
    'Do not read the repository, its files, but show me its status',
    'Inspect the repository files, but do not check the deployed Git revision.',
    'Show me the repo status. Do not check the deployed Git revision.'
  ])('preserves an affirmative inspection beside a negated check: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(true);
  });

  it.each([
    'This is my repository. What can ARCANOS help me do?',
    'This is my repository. This is a separate topic. Please inspect it.',
    'I mentioned Git. Please inspect the weather.',
    'This is my repository. Please inspect that weather.'
  ])('does not carry repository intent into unrelated statements: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(false);
  });

  it('does not hijack prompt-authoring requests that merely mention repo inspection', () => {
    expect(shouldInspectRepoPrompt('Create a prompt for Codex to inspect the repo and suggest fixes')).toBe(false);
    expect(shouldInspectRepoPrompt('Write a prompt template that inspects the codebase and lists protocol schemas')).toBe(false);
    expect(shouldInspectRepoPrompt('Draft a spec for another agent to inspect the repository and update the docs')).toBe(false);
    expect(shouldInspectRepoPrompt('Help me make Codex fix my repo')).toBe(false);
    expect(shouldInspectRepoPrompt('Generate something that lets another AI update docs')).toBe(false);
  });

  it('still marks explicit verification prompts as verification questions', () => {
    expect(isVerificationQuestion('What commands exist?')).toBe(true);
    expect(isVerificationQuestion('Can you see my codebase?')).toBe(true);
  });
});
