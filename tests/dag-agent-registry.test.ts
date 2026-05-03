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
      expect.stringContaining('Treat the provided dependency outputs as the only available evidence.'),
      expect.objectContaining({
        sessionId: 'user-session-123',
        tokenAuditSessionId: 'user-session-123:dag:dagrun_live_test:audit:a2',
        cognitiveDomain: 'diagnostic',
        toolBackedCapabilities: {
          verifyProvidedData: true
        },
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
        sessionId: 'dag:dagrun_live_test:audit:a2',
        tokenAuditSessionId: 'dag:dagrun_live_test:audit:a2'
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

  it('exposes planner, code, validation, Railway ops, and reviewer sub-agent profiles', async () => {
    const runPromptMock = jest.fn().mockResolvedValue({ ok: true });

    await AGENTS.railway_ops(
      buildExecutionContext({
        node: {
          id: 'railway',
          type: 'agent',
          dependencies: ['planner'],
          executionKey: 'railway_ops',
          metadata: {}
        },
        payload: {
          prompt: 'Inspect Railway status and logs without mutating the environment.'
        }
      }),
      { runPrompt: runPromptMock }
    );

    const prompt = runPromptMock.mock.calls[0]?.[0] as string;
    const options = runPromptMock.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(Object.keys(AGENTS)).toEqual(expect.arrayContaining([
      'planner',
      'code',
      'validation',
      'railway_ops',
      'reviewer'
    ]));
    expect(prompt).toContain('Role:');
    expect(prompt).toContain('Railway ops sub-agent');
    expect(prompt).toContain('Inspect files first');
    expect(prompt).toContain('railway status');
    expect(prompt).toContain('railway logs');
    expect(prompt).toContain('require explicit approval');
    expect(options).toEqual(expect.objectContaining({
      cognitiveDomain: 'diagnostic',
      sourceEndpoint: 'dag.agent.railway_ops',
      toolBackedCapabilities: {
        verifyProvidedData: true
      }
    }));
  });

  it('keeps reviewer agents scoped to provided evidence and protected GPT access routes', async () => {
    const runPromptMock = jest.fn().mockResolvedValue({ ok: true });

    await AGENTS.reviewer(
      buildExecutionContext({
        node: {
          id: 'reviewer',
          type: 'agent',
          dependencies: ['code', 'validation'],
          executionKey: 'reviewer',
          metadata: {}
        },
        payload: {
          prompt: 'Review the implementation for prompt compliance and routing safety.'
        }
      }),
      { runPrompt: runPromptMock }
    );

    const prompt = runPromptMock.mock.calls[0]?.[0] as string;

    expect(prompt).toContain('Treat the provided dependency outputs as the only available evidence.');
    expect(prompt).toContain('/gpt-access/*');
    expect(prompt).toContain('/gpt/:gptId');
    expect(runPromptMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourceEndpoint: 'dag.agent.reviewer',
        toolBackedCapabilities: {
          verifyProvidedData: true
        }
      })
    );
  });
});
