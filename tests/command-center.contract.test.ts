import { describe, expect, it, jest } from '@jest/globals';

const mockLogExecution = jest.fn(async () => undefined);

jest.unstable_mockModule('@core/db/repositories/executionLogRepository.js', () => ({
  logExecution: mockLogExecution
}));

const { executeCommand, listAvailableCommands } = await import('../src/services/commandCenter.js');

describe('commandCenter contracts and tracing', () => {
  it('exposes typed schema names for every registered command', () => {
    const commands = listAvailableCommands();

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'audit-safe:set-mode',
          inputSchemaName: 'AuditSafeSetModeInputSchema',
          outputSchemaName: 'AuditSafeSetModeOutputSchema',
          errorSchemaName: 'CommandErrorSchema'
        }),
        expect.objectContaining({
          name: 'audit-safe:interpret',
          inputSchemaName: 'AuditSafeInterpretInputSchema',
          outputSchemaName: 'AuditSafeInterpretOutputSchema',
          errorSchemaName: 'CommandErrorSchema'
        }),
        expect.objectContaining({
          name: 'ai:prompt',
          inputSchemaName: 'AiPromptInputSchema',
          outputSchemaName: 'AiPromptOutputSchema',
          errorSchemaName: 'CommandErrorSchema'
        })
      ])
    );
  });

  it('rejects invalid payloads before handler execution and returns a typed error envelope', async () => {
    const result = await executeCommand('audit-safe:set-mode', { mode: 'invalid-mode' }, {
      traceId: 'trace-cef-invalid',
      executionId: 'exec-invalid',
      stepId: 'step-invalid',
      capabilityId: 'audit-safe-mode-control',
      source: 'test'
    });

    expect(result.success).toBe(false);
    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command payload failed schema validation.'
      })
    );
    expect(result.metadata.traceId).toBe('trace-cef-invalid');
    expect(mockLogExecution).toHaveBeenCalledWith(
      'cef-boundary',
      'warn',
      'cef.command.invalid_payload',
      expect.objectContaining({
        command: 'audit-safe:set-mode',
        traceId: 'trace-cef-invalid',
        executionId: 'exec-invalid',
        capabilityId: 'audit-safe-mode-control',
        stepId: 'step-invalid'
      })
    );
  });

  it('traces successful command execution at the CEF boundary', async () => {
    const result = await executeCommand('audit-safe:set-mode', { mode: 'true' }, {
      traceId: 'trace-cef-success',
      executionId: 'exec-success',
      stepId: 'step-success',
      capabilityId: 'audit-safe-mode-control',
      source: 'test'
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      mode: 'true'
    });
    expect(result.error).toBeNull();
    expect(result.metadata.commandTraceId).toMatch(/^cef_/);
    expect(mockLogExecution).toHaveBeenCalledWith(
      'cef-boundary',
      'info',
      'cef.command.completed',
      expect.objectContaining({
        command: 'audit-safe:set-mode',
        traceId: 'trace-cef-success',
        executionId: 'exec-success',
        capabilityId: 'audit-safe-mode-control',
        stepId: 'step-success'
      })
    );
  });
});
