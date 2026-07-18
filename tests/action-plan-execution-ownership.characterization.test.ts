/**
 * Immutable Phase 2E historical evidence for the pre-change implementation.
 *
 * The active route can no longer satisfy these unsafe assertions. The dated
 * audit records the exact commit and Git blobs that did, while current decision
 * tests prove the corrected command/result contract independently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';
import { executionResultInputSchema, type ActionPlanRecord } from '../src/shared/types/actionPlan.js';

interface HistoricalEvidence {
  baseline: {
    commit: string;
    sourceBlobs: Array<{ blob: string; path: string }>;
  };
  confirmedFlow: {
    python: string[];
    typescriptHttp: string[];
    typescriptMcp: string[];
  };
  findings: Array<{
    finding: string;
    confidence: string;
    risk: string;
  }>;
}

const evidencePath = join(
  process.cwd(),
  'docs',
  'audits',
  'action-plan-execution',
  '2026-07-17',
  'pre-change-behavior.json',
);
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as HistoricalEvidence;

/**
 * Executable reference harness copied from the behavior pinned by the source
 * blobs above. It intentionally ignores the submitted body and fabricates one
 * success row per action. Active production code must never call this harness.
 */
function executeHistoricalCommandHandler(plan: ActionPlanRecord, submittedBody: unknown) {
  void submittedBody;
  return {
    plan_id: plan.id,
    status: 'executed',
    results: plan.actions.map(action => ({
      planId: plan.id,
      actionId: action.id,
      agentId: action.agentId,
      status: 'success',
      clearDecision: 'allow',
    })),
  };
}

function historicalPlan(): ActionPlanRecord {
  const timestamp = new Date('2026-07-17T12:00:00.000Z');
  return {
    id: 'phase2e-historical-plan', createdBy: 'user', origin: 'historical-test',
    status: 'approved', confidence: 0.9, requiresConfirmation: true,
    idempotencyKey: 'historical-key', expiresAt: null, createdAt: timestamp, updatedAt: timestamp,
    clearScore: null,
    actions: [
      { id: 'python-action', planId: 'phase2e-historical-plan', agentId: 'python-daemon', capability: 'terminal.run', params: {}, timeoutMs: 1000, rollbackAction: null, sortOrder: 0 },
      { id: 'unsubmitted-sibling', planId: 'phase2e-historical-plan', agentId: 'python-daemon', capability: 'terminal.run', params: {}, timeoutMs: 1000, rollbackAction: null, sortOrder: 1 },
    ],
  };
}

describe('Phase 2E historical execution ownership baseline', () => {
  it('pins the exact pre-change commit and unsafe TypeScript source blobs', () => {
    expect(evidence.baseline.commit).toBe('410c04a890c021ae51148e58391f8e653be11943');
    expect(evidence.baseline.sourceBlobs).toEqual(expect.arrayContaining([
      {
        blob: '810603ffc0eac47fdd1a74c055b3c36c9275805d',
        path: 'src/routes/plans.ts',
      },
      {
        blob: '2ee2604d30bc3edcbb501094d5d11e3478b30b84',
        path: 'src/mcp/server/index.ts',
      },
      {
        blob: '40deeddc4b85a8ade23ca4d1d6da37e9ac5f3f7f',
        path: 'src/stores/actionPlanStore.ts',
      },
    ]));
  });

  it('preserves the result-through-command and fabricated-sibling-success observations', () => {
    expect(evidence.confirmedFlow.python).toContain(
      'It submits that outcome to POST /plans/:planId/execute.',
    );
    expect(evidence.confirmedFlow.typescriptHttp).toEqual(expect.arrayContaining([
      'The handler does not read or validate the request body.',
      'It creates status=success ExecutionResult records for every stored action.',
    ]));
    expect(evidence.confirmedFlow.typescriptMcp).toContain(
      'It creates status=success ExecutionResult records for every stored action.',
    );

    const critical = evidence.findings.filter(finding => finding.risk === 'critical');
    expect(critical.map(finding => finding.finding)).toEqual(expect.arrayContaining([
      'A failed Python action can become a backend-recorded success because the submitted failure body is ignored.',
      'Submitting one Python action result can create fabricated success records for sibling actions that were not executed.',
      'Python result submission failure does not prevent completion output or daemon command acknowledgement.',
    ]));
    expect(critical.every(finding => finding.confidence === 'high')).toBe(true);
  });

  it('executable historical harness turns one submitted failure into success for it and its unsubmitted sibling', () => {
    const submittedFailure = {
      action_id: 'python-action',
      agent_id: 'python-daemon',
      status: 'failure',
      error: 'synthetic failure',
    };
    expect(executionResultInputSchema.safeParse(submittedFailure).success).toBe(true);

    expect(executeHistoricalCommandHandler(historicalPlan(), submittedFailure)).toEqual({
      plan_id: 'phase2e-historical-plan',
      status: 'executed',
      results: [
        { planId: 'phase2e-historical-plan', actionId: 'python-action', agentId: 'python-daemon', status: 'success', clearDecision: 'allow' },
        { planId: 'phase2e-historical-plan', actionId: 'unsubmitted-sibling', agentId: 'python-daemon', status: 'success', clearDecision: 'allow' },
      ],
    });
  });

  it('executable historical harness ignores even a malformed result body', () => {
    const malformed = { action_id: 'python-action', status: 'not-valid', output: { ignored: true } };
    expect(executionResultInputSchema.safeParse(malformed).success).toBe(false);
    expect(executeHistoricalCommandHandler(historicalPlan(), malformed).results).toHaveLength(2);
  });
});
