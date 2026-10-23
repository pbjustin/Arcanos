import type { ChatGptBookerOutput, ChatGptBookerToolName } from '@arcanos/protocol';
import type { Request } from 'express';
import { getRequestAbortSignal } from '@arcanos/runtime';
import type { JobData } from '@core/db/schema.js';
import { runWithSessionContext } from '@platform/runtime/sessionContext.js';
import {
  isBookerMcpInput, isBookerMcpOutput, requiresBookerGenerationPermission,
} from '@shared/chatgpt/bookerMcpContract.js';
import { buildBackstageBookerProtectedFailureState } from '@shared/backstage/backstageBookerAsyncContinuation.js';
import { readProtectedBackstageCompletionProvenance } from '@shared/backstage/backstageProtectedFailure.js';
import type { ReadBackstageStorylineSummaryOptions } from '@services/backstageUniverseRead.js';
import type {
  BackstageBookerAsyncResultReadInput, BackstageBookerAsyncResultReadDependencies,
} from '../routes/backstageBookerAsyncResult.js';
import type { ChatGptPrincipal } from './auth.js';
import { hasBookerPermission, bookerPrincipalActorKey } from './bookerAuth.js';
import { invokeBookerGptAction, type BookerGptAction, type BookerGptOptions, type BookerGptResult } from './bookerGptAdapter.js';

export interface BookerMcpServices {
  run: (principal: ChatGptPrincipal, action: BookerGptAction, payload: Record<string, unknown>, options: BookerGptOptions) => Promise<BookerGptResult>;
  universe: (universeId: string) => Promise<unknown>;
  storyline: (universeId: string, storylineKey: string, options: ReadBackstageStorylineSummaryOptions) => Promise<unknown>;
  job: (input: BackstageBookerAsyncResultReadInput, dependencies: BackstageBookerAsyncResultReadDependencies) => Promise<Record<string, unknown>>;
  getJobById: (jobId: string) => Promise<JobData | null>;
}

export class BookerMcpError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function failure(code: string, statusCode = 503): BookerGptResult {
  return { statusCode, result: { ok: false, ...buildBackstageBookerProtectedFailureState({
    code, message: 'Protected Backstage operation did not complete. No official result was established.',
  }) } };
}

/** Preserve the dedicated read boundary's public classification without raw exception text. */
function readFailure(name: 'getBackstageUniverse' | 'getBackstageStoryline', code: unknown,
  options: { requestId?: string; traceId?: string }): BookerGptResult {
  const storyline = name === 'getBackstageStoryline';
  let statusCode = 500;
  let publicCode = storyline ? 'BACKSTAGE_STORYLINE_READ_FAILED' : 'BACKSTAGE_UNIVERSE_READ_FAILED';
  let message = storyline ? 'Backstage storyline summary data could not be read safely.' : 'Backstage universe data could not be read safely.';
  let retryable: boolean | undefined;
  if (code === 'BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED') {
    statusCode = 409; publicCode = code; retryable = false;
    message = 'Notion is authoritative for this Backstage universe; legacy PostgreSQL reads are quarantined.';
  } else if (code === 'BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE') {
    statusCode = 503; publicCode = code; message = 'The Backstage Notion authority state is temporarily unavailable.';
  } else if (code === 'BACKSTAGE_BOOKER_REPOSITORY_UNAVAILABLE') {
    statusCode = 503; publicCode = storyline ? 'BACKSTAGE_STORYLINE_READ_UNAVAILABLE' : 'BACKSTAGE_UNIVERSE_READ_UNAVAILABLE';
    message = storyline ? 'Backstage storyline summary data is temporarily unavailable.' : 'Backstage universe data is temporarily unavailable.';
  } else if (storyline && code === 'GPT_ACCESS_VALIDATION_ERROR') {
    statusCode = 400; publicCode = code; message = 'The Backstage storyline summary read request is invalid.';
  } else if (storyline && code === 'BACKSTAGE_STORYLINE_NOT_FOUND') {
    statusCode = 404; publicCode = code; message = 'No stored Backstage canon storyline was found for this exact universe and key.';
  } else if (storyline && code === 'BACKSTAGE_STORYLINE_VERSION_CONFLICT') {
    statusCode = 409; publicCode = code; message = 'The Backstage storyline changed between summary pages; restart at offset 0.';
  }
  if (statusCode === 503) retryable = true;
  return { statusCode, result: { ok: false, ...(statusCode === 503 ? { status: 'unavailable', service: 'backstage-booker' } : {}),
    error: { code: publicCode, message, ...(retryable === undefined ? {} : { retryable }) }, ...options } };
}

/** Fixed Booker operations only; authority, jobs, persistence and inference remain backend-owned. */
export function createBookerMcpExecutor(overrides: Partial<BookerMcpServices> = {}) {
  const services: BookerMcpServices = {
    run: invokeBookerGptAction,
    universe: async universeId => (await import('@services/backstageUniverseRead.js')).readBackstageUniverse(universeId),
    storyline: async (universeId, storylineKey, options) => (await import('@services/backstageUniverseRead.js')).readBackstageStorylineSummary(universeId, storylineKey, options),
    job: async (input, dependencies) => (await import('../routes/backstageBookerAsyncResult.js')).readBackstageBookerAsyncResult(input, dependencies),
    getJobById: async jobId => (await import('@core/db/repositories/jobRepository.js')).getJobById(jobId),
    ...overrides,
  };
  return async (principal: ChatGptPrincipal, name: ChatGptBookerToolName, input: unknown,
    options: { requestId?: string; traceId?: string; logger?: Request['logger'] } = {}): Promise<ChatGptBookerOutput> => {
    if (!hasBookerPermission(principal, requiresBookerGenerationPermission(name))) throw new BookerMcpError('BOOKER_PERMISSION_DENIED');
    if (!isBookerMcpInput(name, input)) throw new BookerMcpError('BOOKER_INPUT_INVALID');
    const universeId = String(input.universeId);
    if (!hasBookerPermission(principal, requiresBookerGenerationPermission(name), universeId)) throw new BookerMcpError('BOOKER_PERMISSION_DENIED');
    const correlation = { ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}) };
    return runWithSessionContext(undefined, async () => {
      let output: BookerGptResult;
      try {
        getRequestAbortSignal()?.throwIfAborted();
        switch (name) {
          case 'queryContinuity':
          case 'generateBooking':
          case 'generateBookingWithHRC':
          case 'simulateMatch': {
            const { idempotencyKey, ...payload } = input;
            output = await services.run(principal, name, payload, {
              ...correlation, ...(options.logger ? { logger: options.logger } : {}),
              ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
            });
            break;
          }
          case 'getBackstageUniverse':
            output = { statusCode: 200, result: { ok: true, result: await services.universe(universeId), ...correlation } };
            break;
          case 'getBackstageStoryline':
            output = { statusCode: 200, result: { ok: true, result: await services.storyline(universeId, String(input.storylineKey), {
              offset: typeof input.offset === 'number' ? input.offset : 0,
              ...(typeof input.expectedVersion === 'number' ? { expectedVersion: input.expectedVersion } : {}),
            }), ...correlation } };
            break;
          case 'getBackstageBookerJobResult': {
            // Apply the exact current universe membership before any waiter or
            // authenticated unseal. The reused core separately fences actor,
            // creation surface, protected action and completion provenance.
            const getAuthorizedJobById = async (jobId: string) => {
              const job = await services.getJobById(jobId);
              const rawInput = job?.input as { protectedBackstage?: { universeId?: unknown } } | null;
              return rawInput?.protectedBackstage?.universeId === universeId ? job : null;
            };
            output = { statusCode: 200, result: await services.job({
              jobId: String(input.jobId), actorKey: bookerPrincipalActorKey(principal, universeId),
              waitForResultMs: typeof input.waitForResultMs === 'number' ? input.waitForResultMs : 30_000,
              signal: getRequestAbortSignal(),
            }, { getJobByIdFn: getAuthorizedJobById }) };
            break;
          }
        }
      } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        const statuses: Record<string, number> = {
          BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED: 409,
          BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE: 503,
          BACKSTAGE_NOTION_INDEX_UNAVAILABLE: 503,
          BACKSTAGE_STORYLINE_NOT_FOUND: 404,
          BACKSTAGE_STORYLINE_VERSION_CONFLICT: 409,
          BACKSTAGE_ASYNC_RESULT_UNAVAILABLE: 503,
          JOB_REPOSITORY_UNAVAILABLE: 503,
        };
        output = name === 'getBackstageUniverse' || name === 'getBackstageStoryline'
          ? readFailure(name, code, correlation)
          : typeof code === 'string' && Object.hasOwn(statuses, code)
            ? failure(code, statuses[code]) : failure('BOOKER_UNAVAILABLE');
      }
      if ((name === 'generateBooking' || name === 'generateBookingWithHRC') && output.statusCode === 200) {
        const result = output.result.result;
        if (!readProtectedBackstageCompletionProvenance(output.result, { gptId: 'backstage-booker', action: name })
          || !result || typeof result !== 'object' || !('universeId' in result) || result.universeId !== universeId) {
          output = failure('BACKSTAGE_ASYNC_RESULT_UNAVAILABLE');
        }
      }
      if (typeof output.result.jobId === 'string'
        && (output.statusCode === 202 || output.result.status === 'pending' || typeof output.result.instruction === 'string')) {
        output = { ...output, result: { ...output.result,
          instruction: `Call getBackstageBookerJobResult with universeId ${universeId} and jobId ${output.result.jobId} using the same OAuth connection. While pending, continue that job only; do not start another generation.`,
        } };
      }
      if (!isBookerMcpOutput(name, output)) throw new BookerMcpError('BOOKER_OUTPUT_INVALID');
      return output;
    });
  };
}

export const executeBookerMcp = createBookerMcpExecutor();
