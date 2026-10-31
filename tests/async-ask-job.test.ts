import { describe, expect, it } from '@jest/globals';
import type { TrinityResult } from '../src/core/logic/trinity.js';
import {
  getFinalizedPublicAnswerPresentation,
  markFinalizedPublicAnswer
} from '../src/shared/http/clientResponseCommon.js';
import {
  buildCompletedQueuedAskOutput,
  buildQueuedAskJobInput,
  buildQueuedAskPendingResponse,
  parseQueuedAskJobInput
} from '../src/shared/ask/asyncAskJob.js';

describe('async ask job helpers', () => {
  it('builds queued ask job input with normalized endpoint metadata', () => {
    const queuedJobInput = buildQueuedAskJobInput({
      prompt: 'Refactor this TypeScript function.',
      sessionId: 'session-123',
      cognitiveDomain: 'code',
      clientContext: { routingDirectives: ['concise'] },
      endpointName: '   ',
      auditFlag: {
        auditFlag: 'SCHEMA_VALIDATION_BYPASS',
        reason: 'lenient-path',
        timestamp: '2026-03-06T12:00:00.000Z'
      }
    });

    expect(queuedJobInput).toEqual({
      prompt: 'Refactor this TypeScript function.',
      sessionId: 'session-123',
      cognitiveDomain: 'code',
      clientContext: { routingDirectives: ['concise'] },
      endpointName: 'ask',
      auditFlag: {
        auditFlag: 'SCHEMA_VALIDATION_BYPASS',
        reason: 'lenient-path',
        timestamp: '2026-03-06T12:00:00.000Z'
      }
    });
  });

  it('parses raw queued ask job input and applies endpoint fallback', () => {
    const parsedJobInput = parseQueuedAskJobInput({
      prompt: 'Diagnose this exception',
      endpointName: '',
      clientContext: { routingDirectives: ['diagnostic'] },
      previewChaosHook: {
        kind: 'reasoning_timeout_once',
        hookId: 'preview-chaos-test-hook',
        delayBeforeCallMs: 250,
        timeoutMs: 50
      }
    });

    expect(parsedJobInput).toEqual({
      ok: true,
      value: {
        prompt: 'Diagnose this exception',
        endpointName: 'ask',
        clientContext: { routingDirectives: ['diagnostic'] },
        previewChaosHook: {
          kind: 'reasoning_timeout_once',
          hookId: 'preview-chaos-test-hook',
          delayBeforeCallMs: 250,
          timeoutMs: 50
        }
      }
    });
  });

  it('fails malformed queued ask job input explicitly', () => {
    const parsedJobInput = parseQueuedAskJobInput({
      prompt: '',
      endpointName: 'ask'
    });

    expect(parsedJobInput.ok).toBe(false);
    if (parsedJobInput.ok) {
      throw new Error('Expected malformed queued ask job input to fail parsing.');
    }

    expect(parsedJobInput.error).toContain('prompt');
  });

  it.each([undefined, false, true])('builds completed output with client metadata (includePresentation=%s)', includePresentation => {
    const trinityResult = markFinalizedPublicAnswer<TrinityResult>(
      {
        result: 'Refactored version ready.',
        module: 'arcanos-final',
        meta: {
          id: 'resp-123',
          created: 1772810000
        },
        activeModel: 'ft:gpt-4.1',
        fallbackFlag: false,
        dryRun: false,
        gpt5Used: true,
        gpt5Model: 'gpt-5.1',
        fallbackSummary: {
          intakeFallbackUsed: false,
          gpt5FallbackUsed: false,
          finalFallbackUsed: false,
          fallbackReasons: []
        },
        auditSafe: {
          mode: false,
          overrideUsed: false,
          auditFlags: [],
          processedSafely: true
        },
        memoryContext: {
          entriesAccessed: 0,
          contextSummary: '',
          memoryEnhanced: false,
          maxRelevanceScore: 0,
          averageRelevanceScore: 0
        },
        taskLineage: {
          requestId: 'trinity-123',
          logged: true
        },
        outputControls: {
          requestedVerbosity: 'normal',
          maxWords: null,
          answerMode: 'explained',
          debugPipeline: false,
          strictUserVisibleOutput: true
        }
      }
    );
    const jobInput = buildQueuedAskJobInput({
      prompt: 'Refactor this TypeScript function.',
      endpointName: 'brain',
      clientContext: { routingDirectives: ['concise'] },
      auditFlag: {
        auditFlag: 'SCHEMA_VALIDATION_BYPASS',
        reason: 'lenient-path',
        timestamp: '2026-03-06T12:00:00.000Z'
      }
    });
    const completedOutput = buildCompletedQueuedAskOutput(
      trinityResult,
      jobInput,
      { includePresentation }
    );

    expect(completedOutput).toEqual({
      result: 'Refactored version ready.',
      module: 'arcanos-final',
      meta: {
        id: 'resp-123',
        created: 1772810000
      },
      activeModel: 'ft:gpt-4.1',
      ...(includePresentation ? { presentation: 'public-answer-v1' } : {}),
      fallbackFlag: false,
      endpoint: 'brain',
      gpt5Used: true,
      gpt5Model: 'gpt-5.1',
      dryRun: false,
      clientContext: { routingDirectives: ['concise'] },
      auditFlag: {
        auditFlag: 'SCHEMA_VALIDATION_BYPASS',
        reason: 'lenient-path',
        timestamp: '2026-03-06T12:00:00.000Z'
      }
    });
    const restoredJobData = JSON.parse(JSON.stringify({ output: completedOutput }));
    expect(restoredJobData.output.result).toBe(trinityResult.result);
    if (includePresentation) {
      expect(restoredJobData.output.presentation).toBe('public-answer-v1');
    } else {
      expect(completedOutput).not.toHaveProperty('presentation');
      expect(restoredJobData.output).not.toHaveProperty('presentation');
    }
    expect(getFinalizedPublicAnswerPresentation(trinityResult)).toBe('public-answer-v1');
  });

  it('builds pending queue responses with a poll URL', () => {
    expect(buildQueuedAskPendingResponse('job-123')).toEqual({
      ok: true,
      status: 'pending',
      jobId: 'job-123',
      poll: '/jobs/job-123/result',
      jobReadToken: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
      jobReadTokenHeader: 'x-arcanos-job-read-token'
    });
  });
});
