import { describe, expect, it, jest } from '@jest/globals';
import type { CommandExecutionResult, CommandName } from '../src/services/commandCenter.js';
import { createAgentExecutionService } from '../src/services/agentExecutionService.js';
import { AgentExecutionTraceRecorder } from '../src/services/agentExecutionTraceService.js';

describe('agentExecutionService', () => {
  it('executes a two-step goal through the DAG path and returns structured results', async () => {
    const commandExecutor = jest.fn(async (command: CommandName, payload?: Record<string, unknown>): Promise<CommandExecutionResult> => {
      if (command === 'audit-safe:set-mode') {
        return {
          success: true,
          command,
          message: 'Audit-Safe mode updated.',
          output: {
            mode: payload?.mode ?? null
          },
          metadata: {
            executedAt: '2026-03-09T12:00:00.000Z',
            auditSafeMode: String(payload?.mode ?? 'unknown')
          }
        };
      }

      return {
        success: true,
        command,
        message: 'Prompt completed.',
        output: {
          result: 'system summary'
        },
        metadata: {
          executedAt: '2026-03-09T12:00:01.000Z',
          auditSafeMode: 'true'
        }
      };
    });
    const service = createAgentExecutionService({
      commandExecutor,
      createTraceRecorder: (executionId, traceId) => new AgentExecutionTraceRecorder(executionId, traceId)
    });

    const response = await service.executeGoal({
      goal: 'Enable audit safe mode and summarize the current system status.',
      payload: {
        mode: 'true'
      },
      executionMode: 'dag',
      traceId: 'trace-agent-dag'
    });

    expect(response.planner.executionMode).toBe('dag');
    expect(response.execution.status).toBe('completed');
    expect(response.execution.dagSummary).not.toBeNull();
    expect(response.execution.steps).toHaveLength(2);
    expect(response.execution.steps.map(step => step.status)).toEqual(['completed', 'completed']);
    expect(response.execution.finalOutput).toEqual({
      result: 'system summary'
    });
    expect(commandExecutor).toHaveBeenCalledTimes(2);
    expect(commandExecutor).toHaveBeenNthCalledWith(
      1,
      'audit-safe:set-mode',
      { mode: 'true' },
      expect.objectContaining({
        traceId: 'trace-agent-dag',
        capabilityId: 'audit-safe-mode-control',
        stepId: 'step_1'
      })
    );
    expect(response.logs.some(log => log.message === 'agent.execution.completed')).toBe(true);
  });

  it('marks dependent serial steps as skipped after a failed prerequisite', async () => {
    const commandExecutor = jest.fn(async (command: CommandName): Promise<CommandExecutionResult> => {
      if (command === 'audit-safe:set-mode') {
        return {
          success: false,
          command,
          message: 'Failed to update audit-safe mode.',
          output: null,
          metadata: {
            executedAt: '2026-03-09T12:00:00.000Z',
            auditSafeMode: 'false'
          }
        };
      }

      return {
        success: true,
        command,
        message: 'Unexpected success.',
        output: {
          result: 'should not run'
        },
        metadata: {
          executedAt: '2026-03-09T12:00:01.000Z',
          auditSafeMode: 'false'
        }
      };
    });
    const service = createAgentExecutionService({
      commandExecutor,
      createTraceRecorder: (executionId, traceId) => new AgentExecutionTraceRecorder(executionId, traceId)
    });

    const response = await service.executeGoal({
      goal: 'Disable audit safe mode and summarize the current system status.',
      payload: {
        mode: 'false',
        prompt: 'Summarize the current system status.'
      },
      executionMode: 'serial',
      traceId: 'trace-agent-serial'
    });

    expect(response.execution.status).toBe('failed');
    expect(response.execution.dagSummary).toBeNull();
    expect(response.execution.steps).toHaveLength(2);
    expect(response.execution.steps[0]).toMatchObject({
      status: 'failed',
      success: false
    });
    expect(response.execution.steps[1]).toMatchObject({
      status: 'skipped',
      success: false
    });
    expect(commandExecutor).toHaveBeenCalledTimes(1);
  });
});
