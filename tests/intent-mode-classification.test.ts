import { describe, expect, it } from '@jest/globals';

import { classifyIntentMode } from '../src/shared/text/intentModeClassifier.js';

describe('intent mode classification', () => {
  it.each([
    {
      prompt: 'Write a prompt for Codex to inspect the repo and fix docs',
      artifactKinds: ['prompt'],
      executorKinds: ['codex'],
      reason: 'artifact_requested_for_downstream_executor',
    },
    {
      prompt: 'Create instructions for an agent to verify the API',
      artifactKinds: ['instructions'],
      executorKinds: ['agent'],
      reason: 'artifact_requested_for_downstream_executor',
    },
    {
      prompt: 'Draft a spec for an AI to audit deployment config',
      artifactKinds: ['spec'],
      executorKinds: ['ai'],
      reason: 'artifact_requested_for_downstream_executor',
    },
    {
      prompt: 'Make a system prompt telling a model to update documentation',
      artifactKinds: ['system_prompt'],
      executorKinds: ['model'],
      reason: 'artifact_requested_for_downstream_executor',
    },
    {
      prompt: 'Help me make Codex fix my repo',
      artifactKinds: [],
      executorKinds: ['codex'],
      reason: 'downstream_executor_instruction_requested',
    },
    {
      prompt: 'Generate something that lets another AI update docs',
      artifactKinds: [],
      executorKinds: ['ai'],
      reason: 'downstream_executor_instruction_requested',
    },
    {
      prompt: 'Give me something I can hand to Codex to fix this',
      artifactKinds: [],
      executorKinds: ['codex'],
      reason: 'delegated_deliverable_for_downstream_executor',
    },
    {
      prompt: 'Write what I should send another model',
      artifactKinds: [],
      executorKinds: ['model'],
      reason: 'delegated_deliverable_for_downstream_executor',
    },
    {
      prompt: 'Draft the tasking for an AI to handle this',
      artifactKinds: ['tasking_document'],
      executorKinds: ['ai'],
      reason: 'artifact_requested_for_downstream_executor',
    },
    {
      prompt: 'Make the instructions another tool would follow',
      artifactKinds: ['instructions'],
      executorKinds: ['tool'],
      reason: 'artifact_requested_for_downstream_executor',
    },
  ])('classifies prompt-generation request "$prompt" correctly', ({ prompt, artifactKinds, executorKinds, reason }) => {
    const classification = classifyIntentMode(prompt);

    expect(classification.intentMode).toBe('PROMPT_GENERATION');
    expect(classification.requestedArtifactKinds).toEqual(expect.arrayContaining(artifactKinds));
    expect(classification.downstreamExecutorKinds).toEqual(expect.arrayContaining(executorKinds));
    expect(classification.reason).toBe(reason);
  });

  it.each([
    'Inspect the repo and fix the docs',
    'Verify the API endpoints',
    'Update the deployment config',
    'Fix this',
    'Inspect the repo',
    'Update the docs',
    'Verify the deployment config',
  ])('keeps execution request "%s" in EXECUTE_TASK', (prompt) => {
    expect(classifyIntentMode(prompt)).toMatchObject({
      intentMode: 'EXECUTE_TASK',
      artifactRequested: false,
    });
  });

  it('prefers prompt generation when artifact requests and execution verbs appear together', () => {
    expect(classifyIntentMode('Write instructions for another agent to inspect the repo and verify the API')).toMatchObject({
      intentMode: 'PROMPT_GENERATION',
      artifactRequested: true,
      downstreamExecutorImplied: true,
      reason: 'artifact_requested_for_downstream_executor',
    });
  });
});
