/**
 * Plan Routes Integration Tests
 *
 * Tests the ActionPlan API endpoints for correct behavior.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  actionPlanInputSchema,
  agentRegistrationSchema,
  executionResultInputSchema,
} from '../src/types/actionPlan.js';
import type { ActionPlanInput } from '../src/types/actionPlan.js';

describe('Plan Routes — Schema Validation', () => {
  describe('actionPlanInputSchema', () => {
    it('should validate a correct input', () => {
      const validInput: ActionPlanInput = {
        created_by: 'user',
        origin: 'test',
        confidence: 0.8,
        requires_confirmation: true,
        idempotency_key: 'unique-key',
        actions: [
          {
            agent_id: 'agent-1',
            capability: 'terminal.run',
            params: { command: 'ls' },
          },
        ],
      };

      const result = actionPlanInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('should reject missing required fields', () => {
      const result = actionPlanInputSchema.safeParse({ origin: 'test' });
      expect(result.success).toBe(false);
    });

    it('should reject empty actions array', () => {
      const result = actionPlanInputSchema.safeParse({
        created_by: 'user',
        origin: 'test',
        idempotency_key: 'key',
        actions: [],
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid created_by values', () => {
      const result = actionPlanInputSchema.safeParse({
        created_by: 'hacker',
        origin: 'test',
        idempotency_key: 'key',
        actions: [{ agent_id: 'a1', capability: 'c', params: {} }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('agentRegistrationSchema', () => {
    it('should validate correct registration', () => {
      const valid = agentRegistrationSchema.safeParse({
        role: 'executor',
        capabilities: ['terminal.run'],
      });
      expect(valid.success).toBe(true);
    });

    it('should reject invalid role', () => {
      const invalid = agentRegistrationSchema.safeParse({
        role: 'invalid_role',
        capabilities: ['terminal.run'],
      });
      expect(invalid.success).toBe(false);
    });

    it('should reject empty capabilities', () => {
      const invalid = agentRegistrationSchema.safeParse({
        role: 'executor',
        capabilities: [],
      });
      expect(invalid.success).toBe(false);
    });
  });

  describe('executionResultInputSchema', () => {
    it('should validate correct result', () => {
      const valid = executionResultInputSchema.safeParse({
        action_id: 'a1',
        agent_id: 'agent-1',
        status: 'success',
      });
      expect(valid.success).toBe(true);
    });

    it('should reject invalid status', () => {
      const invalid = executionResultInputSchema.safeParse({
        action_id: 'a1',
        agent_id: 'agent-1',
        status: 'invalid_status',
      });
      expect(invalid.success).toBe(false);
    });

    it('should accept all valid statuses', () => {
      for (const status of ['success', 'failure', 'replayed', 'rejected']) {
        const result = executionResultInputSchema.safeParse({
          action_id: 'a1',
          agent_id: 'agent-1',
          status,
        });
        expect(result.success).toBe(true);
      }
    });
  });
});
