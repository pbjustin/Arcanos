import { describe, expect, it, jest } from '@jest/globals';

const runAskToolMode = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@arcanos/cli/client', () => ({
  invokeTool: jest.fn()
}));

jest.unstable_mockModule('../src/routes/ask/toolRuntime.js', () => ({
  buildToolAskResponse: jest.fn(),
  runAskToolMode,
}));

const {
  shouldInspectRepoPrompt,
  isVerificationQuestion
} = await import('../src/services/repoImplementationEvidence.js');
const { tryDispatchRepoTools } = await import('../src/routes/ask/repoTools.js');
const commaRevisionDisclaimerPrompts = ['', 'but '].flatMap(conjunction => [
  'do not claim knowledge of the deployed Git revision',
  'do not guess the deployed Git revision',
  "don't claim knowledge of the deployed Git revision",
  'don’t guess the deployed Git revision',
  'never claim knowledge of the deployed Git revision',
  'never guess the deployed Git revision',
].map(disclaimer => `What can ARCANOS help me do, ${conjunction}${disclaimer}.`));

describe('repo inspection prompt detection', () => {
  it('requires repo intent instead of matching generic backend language', () => {
    expect(shouldInspectRepoPrompt('What is the backend status right now?')).toBe(false);
    expect(shouldInspectRepoPrompt('Ping the backend and tell me if it is up.')).toBe(false);
  });

  it.each([
    'Explain what ARCANOS can help me do in two short sentences. Do not claim knowledge of your deployed Git revision unless it is verified.',
    'What can ARCANOS help me do? Do not guess the deployed Git revision.',
    'Explain what ARCANOS can help me do; do not claim knowledge of the deployed Git revision.',
    ...commaRevisionDisclaimerPrompts,
  ])('does not combine a conversation request with an unrelated revision disclaimer: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(false);
  });

  it.each(['\n', '\r\n', '\r'].flatMap(newline => [
    'Do not claim knowledge of the deployed Git revision unless it is verified',
    "Don't guess the deployed Git revision",
    'Don’t claim knowledge of the deployed Git revision unless it is verified',
    'Never claim knowledge of the deployed Git revision unless it is verified',
  ].map(disclaimer => ({ newline, disclaimer }))))(
    'does not borrow a repository target from a line-leading disclaimer: $disclaimer ($newline)', ({ newline, disclaimer }) => {
      expect(shouldInspectRepoPrompt(`What can ARCANOS help me do${newline}${disclaimer}`)).toBe(false);
      expect(shouldInspectRepoPrompt(`Inspect the repository files${newline}${disclaimer}`)).toBe(true);
    }
  );

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

  it.each(['\n', '\r\n', '\r'])(
    'does not reuse an earlier repository after an unrelated negated target with %j line endings', (newline) => {
      expect(shouldInspectRepoPrompt(`Do not read repository files${newline}Do not check the weather, what is their status?`))
        .toBe(false);
      expect(shouldInspectRepoPrompt(`Do not read repository files${newline}Do not check the weather${newline}What is its status?`))
        .toBe(false);
    }
  );

  it.each(['\n', '\r\n', '\r'])(
    'retains an existing possessive contrast after multiple prohibitions with %j line endings', (newline) => {
      expect(shouldInspectRepoPrompt(`Do not read repository files${newline}Do not inspect their contents, but show me their status`))
        .toBe(true);
      expect(shouldInspectRepoPrompt(`Do not read repository files${newline}Do not open their contents but check their status`))
        .toBe(true);
    }
  );

  it.each(['\n', '\r\n', '\r'])('retains a wrapped possessive status question with %j line endings', newline => {
    expect(shouldInspectRepoPrompt(`Do not read the repository files${newline}What is their status?`)).toBe(true);
  });

  it.each([
    'Do not read the repository files but show me its status',
    "Don't read the repository files but show me its status",
    'Do not read the repository files, but check their status',
    'Do not read the repository files, what is their status?',
    'Do not read the repository files, what is its status?',
    'Do not read the repository files, but what is their status?',
    'Do not read the repository, its files, what is their status?'
  ])('retains a repository antecedent for an affirmative possessive status request: %s', (prompt) => {
    expect(shouldInspectRepoPrompt(prompt)).toBe(true);
  });

  it.each([
    'Do not read the repository files but show me that recipe',
    'Do not read the repository files but show me your status',
    'Do not read the repository files but do not show me its status',
    'Do not read the repository files. Show me its status',
    'Do not read the repository files, what is your status?',
    'Do not read the repository files, do not check their status',
    'Do not read the repository files. What is their status?',
    'Do not read the repository files, the weather, what is their status?',
    'Do not read the repository files, what is the weather?',
    'Do not read the repository files, what is their status for that recipe?'
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
    'List repository files, CLI commands, and Git status.',
    'Inspect the repository files, but do not claim knowledge of the deployed Git revision.',
    'Do not claim knowledge of the deployed Git revision, but inspect the repository files.',
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

describe('repository status routing through the ask tool caller', () => {
  it.each([
    ['Do not read the repository files, what is their status?', true],
    ['Do not read the repository files, the weather, what is their status?', false],
    ['Do not read the repository files. What is their status?', false],
    ['List repository files, CLI commands, and Git status.', true],
    ['Inspect the repository files, but do not claim knowledge of the deployed Git revision.', true],
    ['Do not read the repository files, but show me their status', true],
    ['Do not read repository files\nDo not check the weather, what is their status?', false],
    ...commaRevisionDisclaimerPrompts.map(prompt => [prompt, false] as const),
    ...['\n', '\r\n', '\r'].map(newline => [
      `What can ARCANOS help me do${newline}Do not claim knowledge of the deployed Git revision unless it is verified`, false,
    ] as const),
  ] as const)('dispatches only an affirmative repository status request: %s', async (prompt, requested) => {
    runAskToolMode.mockReset();
    const response = { result: 'Synthetic repository status.' };
    runAskToolMode.mockResolvedValue(response);
    const client = {} as Parameters<typeof tryDispatchRepoTools>[0];
    const result = await tryDispatchRepoTools(client, prompt);
    if (requested) {
      expect(result).toBe(response);
      expect(runAskToolMode).toHaveBeenCalledTimes(1);
      expect(runAskToolMode).toHaveBeenCalledWith(expect.objectContaining({ client, prompt, moduleName: 'repo-tools' }));
    } else {
      expect(result).toBeNull();
      expect(runAskToolMode).not.toHaveBeenCalled();
    }
  });
});
