/**
 * CLEAR 2.0 Scoring Engine Tests
 */

import { describe, it, expect } from '@jest/globals';
import {
  computeClear2CompositeScore,
  evaluateClear2Decision,
  normalizeClear2Weights,
  computeClear2PrincipleScores,
  buildClear2Summary,
  buildClear2SummaryFromScores,
  CLEAR2_DEFAULT_WEIGHTS,
  CLEAR2_DEFAULT_THRESHOLDS,
} from '../src/services/clear2.js';

describe('CLEAR 2.0 Scoring Engine', () => {
  describe('normalizeClear2Weights', () => {
    it('should normalize default weights to sum to 1', () => {
      const normalized = normalizeClear2Weights(CLEAR2_DEFAULT_WEIGHTS);
      const sum = Object.values(normalized).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(0.001);
    });

    it('should normalize custom weights', () => {
      const weights = { clarity: 1, leverage: 1, efficiency: 1, alignment: 1, resilience: 1 };
      const normalized = normalizeClear2Weights(weights);
      expect(normalized.clarity).toBeCloseTo(0.2);
      expect(normalized.leverage).toBeCloseTo(0.2);
    });

    it('should throw on zero-sum weights', () => {
      const weights = { clarity: 0, leverage: 0, efficiency: 0, alignment: 0, resilience: 0 };
      expect(() => normalizeClear2Weights(weights)).toThrow();
    });

    it('should throw on non-finite weights', () => {
      const weights = { clarity: NaN, leverage: 1, efficiency: 1, alignment: 1, resilience: 1 };
      expect(() => normalizeClear2Weights(weights)).toThrow();
    });
  });

  describe('computeClear2CompositeScore', () => {
    it('should compute weighted composite score', () => {
      const scores = { clarity: 0.8, leverage: 0.7, efficiency: 0.6, alignment: 0.9, resilience: 0.5 };
      const result = computeClear2CompositeScore(scores);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should return 1 for all perfect scores', () => {
      const scores = { clarity: 1, leverage: 1, efficiency: 1, alignment: 1, resilience: 1 };
      const result = computeClear2CompositeScore(scores);
      expect(result).toBeCloseTo(1);
    });

    it('should return 0 for all zero scores', () => {
      const scores = { clarity: 0, leverage: 0, efficiency: 0, alignment: 0, resilience: 0 };
      const result = computeClear2CompositeScore(scores);
      expect(result).toBe(0);
    });

    it('should throw for scores outside 0-1 range', () => {
      const scores = { clarity: 1.5, leverage: 0.7, efficiency: 0.6, alignment: 0.9, resilience: 0.5 };
      expect(() => computeClear2CompositeScore(scores)).toThrow();
    });

    it('should throw for NaN scores', () => {
      const scores = { clarity: NaN, leverage: 0.7, efficiency: 0.6, alignment: 0.9, resilience: 0.5 };
      expect(() => computeClear2CompositeScore(scores)).toThrow();
    });
  });

  describe('evaluateClear2Decision', () => {
    it('should return allow for scores >= 0.70', () => {
      expect(evaluateClear2Decision(0.70)).toBe('allow');
      expect(evaluateClear2Decision(0.95)).toBe('allow');
      expect(evaluateClear2Decision(1.0)).toBe('allow');
    });

    it('should return confirm for scores 0.40-0.69', () => {
      expect(evaluateClear2Decision(0.40)).toBe('confirm');
      expect(evaluateClear2Decision(0.55)).toBe('confirm');
      expect(evaluateClear2Decision(0.699)).toBe('confirm');
    });

    it('should return block for scores < 0.40', () => {
      expect(evaluateClear2Decision(0.0)).toBe('block');
      expect(evaluateClear2Decision(0.20)).toBe('block');
      expect(evaluateClear2Decision(0.399)).toBe('block');
    });

    it('should use custom thresholds', () => {
      const thresholds = { allowMinimum: 0.80, confirmMinimum: 0.50 };
      expect(evaluateClear2Decision(0.80, thresholds)).toBe('allow');
      expect(evaluateClear2Decision(0.60, thresholds)).toBe('confirm');
      expect(evaluateClear2Decision(0.40, thresholds)).toBe('block');
    });
  });

  describe('computeClear2PrincipleScores', () => {
    it('should return scores in 0-1 range', () => {
      const input = {
        actions: [{ agent_id: 'a1', capability: 'terminal.run', params: { cmd: 'ls' } }],
        origin: 'user',
        confidence: 0.8,
      };
      const scores = computeClear2PrincipleScores(input);
      for (const key of ['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'] as const) {
        expect(scores[key]).toBeGreaterThanOrEqual(0);
        expect(scores[key]).toBeLessThanOrEqual(1);
      }
    });

    it('should give higher resilience with rollbacks', () => {
      const base = {
        actions: [{ agent_id: 'a1', capability: 'terminal.run', params: { cmd: 'ls' } }],
        origin: 'user',
        confidence: 0.5,
        hasRollbacks: false,
      };
      const withRollbacks = { ...base, hasRollbacks: true };
      const scoresBase = computeClear2PrincipleScores(base);
      const scoresRollback = computeClear2PrincipleScores(withRollbacks);
      expect(scoresRollback.resilience).toBeGreaterThan(scoresBase.resilience);
    });

    it('should penalize many actions on efficiency', () => {
      const manyActions = Array.from({ length: 10 }, (_, i) => ({
        agent_id: `a${i}`,
        capability: 'terminal.run',
        params: { cmd: `cmd${i}` },
      }));
      const few = {
        actions: [{ agent_id: 'a1', capability: 'terminal.run', params: { cmd: 'ls' } }],
        origin: 'user',
        confidence: 0.5,
      };
      const many = { actions: manyActions, origin: 'user', confidence: 0.5 };
      expect(computeClear2PrincipleScores(few).efficiency).toBeGreaterThan(
        computeClear2PrincipleScores(many).efficiency
      );
    });
  });

  describe('buildClear2Summary', () => {
    it('should return a complete score with decision', () => {
      const input = {
        actions: [{ agent_id: 'a1', capability: 'terminal.run', params: { cmd: 'ls' } }],
        origin: 'user',
        confidence: 0.8,
        hasRollbacks: true,
        capabilitiesKnown: true,
        agentsRegistered: true,
      };
      const summary = buildClear2Summary(input);
      expect(summary.overall).toBeGreaterThan(0);
      expect(['allow', 'confirm', 'block']).toContain(summary.decision);
      expect(summary.notes).toBeTruthy();
    });
  });

  describe('buildClear2SummaryFromScores', () => {
    it('should compute overall and decision from raw scores', () => {
      const scores = { clarity: 0.9, leverage: 0.8, efficiency: 0.7, alignment: 0.85, resilience: 0.75 };
      const summary = buildClear2SummaryFromScores(scores);
      expect(summary.decision).toBe('allow');
      expect(summary.overall).toBeGreaterThanOrEqual(0.7);
    });

    it('should block low scores', () => {
      const scores = { clarity: 0.1, leverage: 0.2, efficiency: 0.1, alignment: 0.15, resilience: 0.1 };
      const summary = buildClear2SummaryFromScores(scores);
      expect(summary.decision).toBe('block');
    });
  });
});
