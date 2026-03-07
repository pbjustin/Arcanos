import { describe, expect, it, jest } from '@jest/globals';
import { AGENTS } from '../src/agents/registry.js';
import type { DAGNodeExecutionContext } from '../src/dag/dagNode.js';

function buildExecutionContext(overrides: Partial<DAGNodeExecutionContext> = {}): DAGNodeExecutionContext {
  return {
    dagId: 'dagrun_live_test',
    node: {
      id: 'audit',
      type: 'agent',
      dependencies: ['planner', 'research', 'build'],
      executionKey: 'audit',
      metadata: {}
    },
    payload: {
      prompt: 'Audit the planned work for correctness, risks, and regressions.'
    },
    dependencyResults: {},
    sharedState: {
      sessionId: 'user-session-123'
    },
    depth: 1,
    attempt: 2,
    ...overrides
  };
}

describe('DAG agent registry', () => {
  it('reuses the parent Trinity session when the DAG run provides one', async () => {
    const runPromptMock = jest.fn().mockResolvedValue({ ok: true });

    await AGENTS.audit(buildExecutionContext(), {
      runPrompt: runPromptMock
    });

    expect(runPromptMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: 'user-session-123',
        cognitiveDomain: 'diagnostic',
        sourceEndpoint: 'dag.agent.audit'
      })
    );
  });

  it('falls back to a deterministic synthetic session when no parent session exists', async () => {
    const runPromptMock = jest.fn().mockResolvedValue({ ok: true });

    await AGENTS.audit(
      buildExecutionContext({
        sharedState: {}
      }),
      {
        runPrompt: runPromptMock
      }
    );

    expect(runPromptMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: 'dag:dagrun_live_test:audit:a2'
      })
    );
  });

  it('truncates oversized dependency output before building downstream prompts', async () => {
    const runPromptMock = jest.fn().mockResolvedValue({ ok: true });
    const oversizedOutput = 'x'.repeat(8000);

    await AGENTS.audit(
      buildExecutionContext({
        dependencyResults: {
          planner: {
            nodeId: 'planner',
            status: 'success',
            output: {
              summary: oversizedOutput
            }
          }
        }
      }),
      {
        runPrompt: runPromptMock
      }
    );

    const prompt = runPromptMock.mock.calls[0]?.[0] as string;

    expect(prompt).toContain('Dependency Node: planner');
    expect(prompt).toContain('[truncated');
    expect(prompt.length).toBeLessThan(5000);
  });
});
