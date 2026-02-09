/**
 * ActionPlan Store Tests
 *
 * Tests plan CRUD, CLEAR scoring integration, and status transitions.
 * Note: These tests require a database connection or mock Prisma client.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { ActionPlanInput } from '../src/types/actionPlan.js';

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

const { createPlan, getPlan, approvePlan, blockPlan } = await import(
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
});
