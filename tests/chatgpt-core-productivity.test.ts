import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getEnv = jest.fn<(name: string) => string | undefined>();
const contextSummary = jest.fn<(value: unknown, context: unknown) => Promise<unknown>>();
const focusToday = jest.fn();
const metadata = { risk: 'readonly', requiresConfirmation: false };

jest.unstable_mockModule('@platform/runtime/env.js', () => ({ getEnv }));
jest.unstable_mockModule('@services/arcanos-productivity.js', () => ({
  ArcanosProductivity: {
    actionMetadata: { 'context.summary': metadata, 'focus.today': metadata },
    actions: { 'context.summary': contextSummary, 'focus.today': focusToday }
  }
}));

const { inspectChatGptCoreProductivity } = await import('../src/services/chatgptCoreProductivity.js');

describe('Core MCP productivity reads', () => {
  const actorKey = 'chatgpt-core:synthetic-owner';
  beforeEach(() => {
    const environment: Record<string, string> = {
      CHATGPT_CORE_PRODUCTIVITY_PRINCIPAL_ID: 'owner-principal',
      CHATGPT_CORE_PRODUCTIVITY_WORKSPACE_ID: 'owner-workspace'
    };
    getEnv.mockReset().mockImplementation(name => environment[name]);
    metadata.requiresConfirmation = false;
    contextSummary.mockReset();
    focusToday.mockReset();
  });

  it('requires an explicit tenant mapping and does not bypass confirmation if policy changes', async () => {
    getEnv.mockReturnValueOnce(undefined);
    await expect(inspectChatGptCoreProductivity('summary', actorKey)).resolves.toBeNull();
    metadata.requiresConfirmation = true;
    await expect(inspectChatGptCoreProductivity('focus', actorKey)).resolves.toBeNull();
    expect(contextSummary).not.toHaveBeenCalled();
    expect(focusToday).not.toHaveBeenCalled();
  });

  it('uses the configured tenant, strips private record details, and redacts credential-shaped titles', async () => {
    const summary = {
      tasks: { open: 1, inbox: 0, next: 1, scheduled: 0, waiting: 0, overdue: 0, completed: 0 },
      projects: { active: 1, blocked: 0, onHold: 0, missingNextAction: 0 },
      knowledge: { notes: 3 }, reviews: { dailyDue: false, weeklyDue: true }
    };
    const generatedAt = '2026-11-27T14:30:00.000Z';
    contextSummary.mockResolvedValue({
      ok: true, action: 'context.summary', persisted: false,
      data: { generatedAt, summary, warnings: ['private-diagnostic'], focus: [{
        item: { id: 'private-task', title: 'Rotate Bearer syntheticcredential', dueAt: null, details: 'private-notes' },
        project: { id: 'private-project', title: 'Maintenance' }, reasonCodes: ['active_project']
      }] }
    });
    await expect(inspectChatGptCoreProductivity('summary', actorKey)).resolves.toEqual({
      view: 'summary', generatedAt, summary, focus: [{
        item: { title: 'Rotate Bearer [REDACTED]', dueAt: null },
        project: { title: 'Maintenance' }, reasonCodes: ['active_project']
      }]
    });
    expect(contextSummary).toHaveBeenCalledWith({}, {
      source: 'gpt-access', principalId: 'owner-principal', workspaceId: 'owner-workspace', actorKey
    });
  });
});
