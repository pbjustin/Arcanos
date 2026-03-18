import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const invokeToolMock = jest.fn();
const shouldInspectRepoPromptMock = jest.fn();

jest.unstable_mockModule('@arcanos/cli/client', () => ({
  invokeTool: invokeToolMock
}));

jest.unstable_mockModule('@services/repoImplementationEvidence.js', () => ({
  shouldInspectRepoPrompt: shouldInspectRepoPromptMock
}));

const { tryDispatchRepoTools } = await import('../src/routes/ask/repoTools.js');

describe('repo tool ask mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets the model call repository tools before answering', async () => {
    shouldInspectRepoPromptMock.mockReturnValue(true);
    invokeToolMock.mockResolvedValue({
      status: 'implemented',
      checks: [{ name: 'repo_tools', status: 'pass' }]
    });

    const responsesCreate = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp-1',
        output: [
          {
            type: 'function_call',
            name: 'doctor_implementation',
            call_id: 'call-1',
            arguments: '{}'
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The CLI is implemented based on repo inspection.' }]
          }
        ]
      });

    const response = await tryDispatchRepoTools(
      { responses: { create: responsesCreate } } as any,
      'Is my CLI implemented?'
    );

    expect(response).not.toBeNull();
    expect(invokeToolMock).toHaveBeenCalledWith({
      toolId: 'doctor.implementation',
      inputs: {}
    });
    expect(response?.result).toContain('implemented');
    expect(response?.module).toBe('repo-tools');
  });

  it('returns null for non-repository prompts', async () => {
    shouldInspectRepoPromptMock.mockReturnValue(false);

    const response = await tryDispatchRepoTools(
      { responses: { create: jest.fn() } } as any,
      'Tell me a joke.'
    );

    expect(response).toBeNull();
    expect(invokeToolMock).not.toHaveBeenCalled();
  });
});
