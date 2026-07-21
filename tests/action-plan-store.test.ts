/**
 * ActionPlan Store Tests
 *
 * Tests plan CRUD, CLEAR scoring integration, and status transitions.
 * Note: These tests require a database connection or mock Prisma client.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { ActionPlanInput } from '../src/shared/types/actionPlan.js';

// Mock Prisma client for testing
const mockPrismaCreate = jest.fn();
const mockPrismaFindUnique = jest.fn();
const mockPrismaFindMany = jest.fn();
const mockPrismaUpdate = jest.fn();
const mockPrismaUpdateMany = jest.fn();
const mockExecutionCreate = jest.fn();
const mockExecutionFindMany = jest.fn();

jest.unstable_mockModule('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    actionPlan: {
      create: mockPrismaCreate,
      findUnique: mockPrismaFindUnique,
      findMany: mockPrismaFindMany,
      update: mockPrismaUpdate,
      updateMany: mockPrismaUpdateMany,
    },
    executionResult: {
      create: mockExecutionCreate,
      findMany: mockExecutionFindMany,
    },
  })),
}));

const {
  createPlan,
  getPlan,
  approvePlan,
  blockPlan,
  createExecutionResult,
  getExecutionResults,
} = await import(
  '../src/stores/actionPlanStore.js'
);

describe('ActionPlan Store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const sampleInput: ActionPlanInput = {
    created_by: 'user',
    origin: 'test-suite',
    confidence: 0.8,
    requires_confirmation: true,
    idempotency_key: 'test-key-1',
    actions: [
      {
        agent_id: 'agent-1',
        capability: 'terminal.run',
        params: { command: 'echo hello' },
        timeout_ms: 5000,
      },
    ],
  };

  describe('createPlan', () => {
    it('should create a plan with CLEAR score', async () => {
      const mockPlan = {
        id: 'plan-1',
        createdBy: 'user',
        origin: 'test-suite',
        status: 'awaiting_confirmation',
        confidence: 0.8,
        requiresConfirmation: true,
        idempotencyKey: 'test-key-1',
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        actions: [
          {
            id: 'action-1',
            planId: 'plan-1',
            agentId: 'agent-1',
            capability: 'terminal.run',
            params: { command: 'echo hello' },
            timeoutMs: 5000,
            rollbackAction: null,
            sortOrder: 0,
          },
        ],
        clearScore: {
          id: 'score-1',
          planId: 'plan-1',
          clarity: 0.85,
          leverage: 0.7,
          efficiency: 0.8,
          alignment: 0.74,
          resilience: 0.7,
          overall: 0.77,
          decision: 'allow',
          notes: 'CLEAR 2.0 evaluated: ALLOW',
          createdAt: new Date(),
        },
        executionResults: [],
      };

      mockPrismaCreate.mockResolvedValue(mockPlan);

      const result = await createPlan(sampleInput);
      expect(result).toBeDefined();
      expect(result.id).toBe('plan-1');
      expect(mockPrismaCreate).toHaveBeenCalledTimes(1);

      // Verify CLEAR score was included in creation
      const createArg = mockPrismaCreate.mock.calls[0][0];
      expect(createArg.data.clearScore.create).toBeDefined();
      expect(createArg.data.clearScore.create.decision).toBeDefined();
    });
  });

  describe('approvePlan', () => {
    it('should not approve a blocked plan', async () => {
      const blockedPlan = {
        id: 'plan-2',
        status: 'awaiting_confirmation',
        clearScore: { decision: 'block', overall: 0.3 },
        actions: [],
      };

      mockPrismaFindUnique.mockResolvedValue(blockedPlan);

      const result = await approvePlan('plan-2');
      expect(result).toBeNull();
    });

    it('should approve a confirmable plan', async () => {
      const plan = {
        id: 'plan-3',
        status: 'awaiting_confirmation',
        clearScore: { decision: 'confirm', overall: 0.55 },
        actions: [],
      };

      mockPrismaFindUnique.mockResolvedValue(plan);
      mockPrismaUpdate.mockResolvedValue({ ...plan, status: 'approved' });

      const result = await approvePlan('plan-3');
      expect(result).toBeDefined();
      expect(result?.status).toBe('approved');
    });
  });

  describe('execution-result CLEAR decisions', () => {
    it.each(['allow', 'confirm', 'block'] as const)('persists an explicit %s without remapping it', async decision => {
      const planId = `decision-plan-${decision}`;
      const actionId = `decision-action-${decision}`;
      mockExecutionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `result-${decision}`,
        ...data,
        createdAt: new Date('2026-07-17T00:00:00.000Z'),
      }));

      const result = await createExecutionResult(
        planId,
        actionId,
        'agent-decision',
        'success',
        decision,
      );

      expect(mockExecutionCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ clearDecision: decision }),
      }));
      expect(result.clearDecision).toBe(decision);
    });

    it('reuses the first cache-fallback result for a repeated plan/action write', async () => {
      const planId = 'decision-fallback-plan';
      const actionId = 'decision-fallback-action';
      mockExecutionCreate.mockRejectedValue(new Error('synthetic database failure'));

      const first = await createExecutionResult(
        planId,
        actionId,
        'agent-decision',
        'success',
        'allow',
      );
      const repeated = await createExecutionResult(
        planId,
        actionId,
        'agent-decision',
        'success',
        'block',
      );

      expect(repeated).toBe(first);
      expect(repeated.clearDecision).toBe('allow');
      expect(mockExecutionCreate).toHaveBeenCalledTimes(2);
    });

    it('reuses a successful cached result when a repeated database write is rejected', async () => {
      const planId = 'decision-success-retry-plan';
      const actionId = 'decision-success-retry-action';
      const durableRecord = {
        id: 'decision-success-retry-result',
        planId,
        actionId,
        agentId: 'agent-decision',
        status: 'success',
        output: null,
        error: null,
        signature: null,
        clearDecision: 'allow',
        createdAt: new Date('2026-07-17T00:00:00.000Z'),
      };
      mockExecutionCreate
        .mockResolvedValueOnce(durableRecord)
        .mockRejectedValueOnce(new Error('synthetic duplicate rejection'));

      const first = await createExecutionResult(
        planId,
        actionId,
        'agent-decision',
        'success',
        'allow',
      );
      const repeated = await createExecutionResult(
        planId,
        actionId,
        'agent-decision',
        'success',
        'block',
      );

      expect(first).toEqual(durableRecord);
      expect(repeated).toBe(first);
      expect(repeated.clearDecision).toBe('allow');
      expect(mockExecutionCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe('cache fallback eviction', () => {
    it('removes execution-result fallback cache when a plan is evicted', async () => {
      mockPrismaCreate.mockRejectedValue(new Error('db unavailable'));
      mockExecutionCreate.mockRejectedValue(new Error('db unavailable'));
      mockExecutionFindMany.mockRejectedValue(new Error('db unavailable'));

      const anchorPlan = await createPlan({
        ...sampleInput,
        idempotency_key: 'eviction-anchor',
      });

      await createExecutionResult(
        anchorPlan.id,
        anchorPlan.actions[0]?.id ?? 'anchor-action',
        'agent-1',
        'success',
        'allow',
        { ok: true },
        null,
        'sig-anchor'
      );

      const cachedResults = await getExecutionResults(anchorPlan.id);
      expect(cachedResults).toHaveLength(1);

      // Force cache churn above MAX_CACHE_SIZE (200) so the oldest plan gets evicted.
      for (let index = 0; index < 220; index++) {
        await createPlan({
          ...sampleInput,
          idempotency_key: `evict-${index}`,
          actions: [
            {
              agent_id: `agent-${index}`,
              capability: 'terminal.run',
              params: { command: `echo ${index}` },
              timeout_ms: 5000,
            },
          ],
        });
      }

      const resultsAfterEviction = await getExecutionResults(anchorPlan.id);
      expect(resultsAfterEviction).toEqual([]);
    });
  });
});
