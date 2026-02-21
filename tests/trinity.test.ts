/**
 * Smoke/contract tests for Trinity pipeline.
 * Asserts runThroughBrain returns expected TrinityResult shape (dry run path).
 */

import { describe, it, expect } from '@jest/globals';
import OpenAI from 'openai';
import { runThroughBrain } from '../src/core/logic/trinity.js';
import { createRuntimeBudget } from '../src/runtime/runtimeBudget.js';

describe('Trinity pipeline', () => {
  it('returns TrinityResult shape when called with dryRun: true', async () => {
    // Dry run short-circuits before any OpenAI calls; client is not used
    const client = {} as unknown as OpenAI;
    const result = await runThroughBrain(client, 'Hello', undefined, undefined, { dryRun: true }, createRuntimeBudget());

    expect(result).toBeDefined();
    expect(typeof result.result).toBe('string');
    expect(result.module).toBe('dry_run');
    expect(result.activeModel).toBe('dry_run');
    expect(result.dryRun).toBe(true);
    expect(result.fallbackFlag).toBe(false);

    expect(result.fallbackSummary).toBeDefined();
    expect(result.fallbackSummary.intakeFallbackUsed).toBe(false);
    expect(result.fallbackSummary.gpt5FallbackUsed).toBe(false);
    expect(result.fallbackSummary.finalFallbackUsed).toBe(false);
    expect(Array.isArray(result.fallbackSummary.fallbackReasons)).toBe(true);

    expect(result.auditSafe).toBeDefined();
    expect(typeof result.auditSafe.mode).toBe('boolean');
    expect(typeof result.auditSafe.overrideUsed).toBe('boolean');
    expect(Array.isArray(result.auditSafe.auditFlags)).toBe(true);
    expect(typeof result.auditSafe.processedSafely).toBe('boolean');

    expect(result.memoryContext).toBeDefined();
    expect(typeof result.memoryContext.entriesAccessed).toBe('number');
    expect(typeof result.memoryContext.contextSummary).toBe('string');
    expect(typeof result.memoryContext.memoryEnhanced).toBe('boolean');
    expect(typeof result.memoryContext.maxRelevanceScore).toBe('number');
    expect(typeof result.memoryContext.averageRelevanceScore).toBe('number');

    expect(result.taskLineage).toBeDefined();
    expect(typeof result.taskLineage.requestId).toBe('string');
    expect(result.taskLineage.logged).toBe(false);

    expect(result.meta).toBeDefined();
    expect(typeof result.meta.id).toBe('string');
    expect(typeof result.meta.created).toBe('number');

    expect(result.dryRunPreview).toBeDefined();
    expect(Array.isArray(result.dryRunPreview!.routingPlan)).toBe(true);
    expect(result.routingStages).toEqual(result.dryRunPreview!.routingPlan);
    expect(typeof result.gpt5Model).toBe('string');
  });
});
