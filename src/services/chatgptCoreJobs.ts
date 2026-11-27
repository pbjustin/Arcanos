import { getRequestAbortSignal, getRequestRemainingMs, isAbortError } from '@arcanos/runtime';
import { findOrCreateGptJob, getJobById, readRecentCompletedCoreGptJobs } from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { runWithSessionContext } from '@platform/runtime/sessionContext.js';
import { buildGptIdempotencyScopeHash } from '@shared/gpt/gptIdempotency.js';
import { CORE_GPT_ID, CORE_GPT_JOB_PATH, CORE_GPT_JOB_REASON, isCoreGptJobInput } from '@shared/chatgpt/coreJob.js';
import { isCoreMcpInput, type CoreMcpInputs } from '@shared/chatgpt/coreMcpContract.js';
import { isRecord } from '@shared/typeGuards.js';
import { runArcanosCoreQuery } from './arcanos-core.js';
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { sanitizeCoreText } from './chatgptCorePrivacy.js';
import { hasUnsafeBlockingConditions } from './safety/runtimeState.js';
import { waitForQueuedGptJobCompletion } from './queuedGptCompletionService.js';
import { readCoreSession, renderCoreSession, type CoreTurn } from './chatgptCoreSession.js';
import { coreRecordHash, openCoreRecord, resolveCoreStorageKey, sealCoreRecord } from './chatgptCoreStorage.js';

const INITIAL_WAIT_MS = 1_000;
const CONTINUATION_WAIT_MS = 20_000;
const WAIT_RESPONSE_HEADROOM_MS = 500;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const OWNER_PATTERN = /^chatgpt-core:[a-f0-9]{64}$/u;
const MAX_ANSWER_CHARS = 64_000;

interface CoreJobInput {
  owner: string;
  fingerprint: string;
  sessionReference: string | null;
  envelope: string;
}

type CoreQuery = Omit<CoreMcpInputs['coreAsk'], 'idempotencyKey'>;
type CoreCompletedAnswer = {
  answer: string;
  sessionId?: string;
  continuitySaved?: boolean;
};

const generationFailureMessages = {
  CORE_JOB_CANCELLED: 'The Core job was cancelled.',
  CORE_GENERATION_FAILED: 'Core could not complete the request.',
  CORE_PROVIDER_UNAVAILABLE: 'The Core provider is unavailable.',
  CORE_GENERATION_TIMEOUT: 'Core timed out before producing a complete answer.',
  CORE_OPERATION_DENIED: 'This operation is unavailable through Core conversation.',
  CORE_SESSION_NOT_FOUND: 'The Core session is unavailable.',
  CORE_STORAGE_UNAVAILABLE: 'Core storage is unavailable.',
  CORE_UNAVAILABLE: 'The Core operation could not be completed.',
} as const;
type CoreJobFailureCode = keyof typeof generationFailureMessages;

function failureOutcome(code: CoreJobFailureCode) {
  return {
    status: code === 'CORE_JOB_CANCELLED' ? 'cancelled' as const : 'failed' as const,
    output: null,
    errorMessage: code,
    retryable: false,
  };
}

function getCoreJobInput(value: unknown): CoreJobInput | null {
  if (!isRecord(value) || !isCoreGptJobInput(value)
    || value.gptId !== CORE_GPT_ID || value.executionModeReason !== CORE_GPT_JOB_REASON) return null;
  const data = value.protectedCore;
  return isRecord(data) && data.version === 1
    && typeof data.owner === 'string' && OWNER_PATTERN.test(data.owner)
    && typeof data.fingerprint === 'string' && HASH_PATTERN.test(data.fingerprint)
    && (data.sessionReference === null || typeof data.sessionReference === 'string' && HASH_PATTERN.test(data.sessionReference))
    && typeof data.envelope === 'string'
    ? { owner: data.owner, fingerprint: data.fingerprint, sessionReference: data.sessionReference, envelope: data.envelope }
    : null;
}

function checkJobOwnership(job: JobData | null, owner: string, canReadSession: boolean): job is JobData {
  if (!job || job.job_type !== 'gpt') return false;
  const data = getCoreJobInput(job.input);
  return data !== null && data.owner === owner && (!data.sessionReference || canReadSession)
    && job.idempotency_scope_hash === buildGptIdempotencyScopeHash({ surface: 'chatgpt-core', actorKey: owner })
    && job.request_fingerprint_hash === data.fingerprint;
}

function coreSessionReference(owner: string, sessionId?: string): string | null {
  return sessionId ? coreRecordHash(['core-session-reference-v1', owner, sessionId]) : null;
}

/** Use the existing durable dedupe transaction. Only the worker can start model execution. */
export async function enqueueCoreQuery(
  key: Buffer, owner: string, input: CoreMcpInputs['coreAsk'], requestId?: string,
) {
  const { idempotencyKey, ...query } = input;
  const scopeHash = buildGptIdempotencyScopeHash({ surface: 'chatgpt-core', actorKey: owner });
  const idempotencyKeyHash = coreRecordHash(['core-query-idempotency-v1', idempotencyKey]);
  // A repeated utterance may be intentional in a later turn. The retry key
  // distinguishes the two turns even on the repository's fingerprint path.
  const fingerprint = coreRecordHash([
    'core-query-v1', owner, idempotencyKeyHash, query.prompt, query.sessionId, query.answerMode, query.maxOutputTokens,
  ]);
  const envelope = sealCoreRecord(key, 'job-input', owner, fingerprint, query);
  getRequestAbortSignal()?.throwIfAborted();
  const { job } = await findOrCreateGptJob({
    workerId: 'chatgpt-core',
    input: {
      gptId: CORE_GPT_ID,
      requestPath: CORE_GPT_JOB_PATH,
      executionModeReason: CORE_GPT_JOB_REASON,
      protectedCore: {
        version: 1, owner, fingerprint, envelope, sessionReference: coreSessionReference(owner, query.sessionId),
      },
    },
    requestFingerprintHash: fingerprint,
    idempotencyScopeHash: scopeHash,
    idempotencyKeyHash,
    idempotencyOrigin: 'explicit',
    createOptions: { correlationId: requestId, maxRetries: 0 },
  });
  if (!checkJobOwnership(job, owner, true)) throw new Error('CORE_STORAGE_UNAVAILABLE');
  return job.id;
}

function readCompletedAnswer(key: Buffer, owner: string, job: JobData): CoreCompletedAnswer {
  if (!isRecord(job.output) || job.output.version !== 1) throw new Error('CORE_STORAGE_UNAVAILABLE');
  const result = openCoreRecord(key, 'job-output', owner, job.id, job.output.envelope);
  if (!isRecord(result) || typeof result.answer !== 'string' || !result.answer.trim()) {
    throw new Error('CORE_STORAGE_UNAVAILABLE');
  }
  return {
    answer: result.answer,
    ...(typeof result.sessionId === 'string' && typeof result.continuitySaved === 'boolean'
      ? { sessionId: result.sessionId, continuitySaved: result.continuitySaved } : {}),
  };
}

async function readCoreSessionTurns(key: Buffer, owner: string, sessionId: string): Promise<CoreTurn[]> {
  const scopeHash = buildGptIdempotencyScopeHash({ surface: 'chatgpt-core', actorKey: owner });
  const sessionReference = coreSessionReference(owner, sessionId)!;
  const jobs = await readRecentCompletedCoreGptJobs(scopeHash, sessionReference);
  return jobs.reverse().flatMap(job => {
    const record = getCoreJobInput(job.input);
    if (!record || record.sessionReference !== sessionReference || !checkJobOwnership(job, owner, true)) return [];
    const query = openCoreRecord(key, 'job-input', owner, record.fingerprint, record.envelope);
    const result = readCompletedAnswer(key, owner, job);
    if (!isRecord(query) || query.sessionId !== sessionId || typeof query.prompt !== 'string'
      || result.sessionId !== sessionId) throw new Error('CORE_STORAGE_UNAVAILABLE');
    return [{ prompt: query.prompt, answer: result.answer }];
  });
}

export async function getCoreJobResult(
  key: Buffer, owner: string, jobId: string, canReadSession: () => boolean, initial = false,
) {
  const getOwnedJob: typeof getJobById = async id => {
    const job = await getJobById(id);
    return checkJobOwnership(job, owner, canReadSession()) ? job : null;
  };
  const waitCap = initial ? INITIAL_WAIT_MS : CONTINUATION_WAIT_MS;
  const waitForResultMs = Math.min(
    waitCap, Math.max(1, (getRequestRemainingMs() ?? waitCap + WAIT_RESPONSE_HEADROOM_MS) - WAIT_RESPONSE_HEADROOM_MS),
  );
  const outcome = await waitForQueuedGptJobCompletion(jobId, { waitForResultMs, signal: getRequestAbortSignal() }, {
    getJobByIdFn: getOwnedJob,
  });
  const job = outcome.job;
  if (!checkJobOwnership(job, owner, canReadSession()) || outcome.state === 'expired') {
    return { ok: false as const, error: { code: 'CORE_JOB_NOT_FOUND', message: 'The Core job is unavailable or expired.' } };
  }
  if (outcome.state === 'pending') return { ok: true as const, status: 'pending' as const, jobId };
  if (outcome.state !== 'completed') {
    const code = outcome.state === 'cancelled' ? 'CORE_JOB_CANCELLED'
      : job.error_message && Object.hasOwn(generationFailureMessages, job.error_message)
        ? job.error_message as CoreJobFailureCode : 'CORE_GENERATION_FAILED';
    return { ok: false as const, error: { code, message: generationFailureMessages[code] } };
  }
  const result = readCompletedAnswer(key, owner, job);
  if (result.sessionId && !canReadSession()) {
    return { ok: false as const, error: { code: 'CORE_JOB_NOT_FOUND', message: 'The Core job is unavailable or expired.' } };
  }
  return { ok: true as const, status: 'completed' as const, jobId, ...result };
}

/** A private worker branch for fixed Core writing. The generic module dispatcher never receives the Core user input. */
export async function executeCoreQueuedJob(jobId: string, rawInput: unknown, signal?: AbortSignal) {
  const record = getCoreJobInput(rawInput);
  if (!record) return failureOutcome('CORE_STORAGE_UNAVAILABLE');
  let key: Buffer;
  let query: CoreQuery;
  try {
    const stored = await getJobById(jobId);
    if (!checkJobOwnership(stored, record.owner, true)) return failureOutcome('CORE_STORAGE_UNAVAILABLE');
    if (signal?.aborted || stored.cancel_requested_at) return failureOutcome('CORE_JOB_CANCELLED');
    key = resolveCoreStorageKey();
    const raw = openCoreRecord(key, 'job-input', record.owner, record.fingerprint, record.envelope);
    if (!isRecord(raw) || !isCoreMcpInput('coreAsk', { ...raw, idempotencyKey: 'worker-validated' })
      || record.sessionReference !== coreSessionReference(record.owner, typeof raw.sessionId === 'string' ? raw.sessionId : undefined)) {
      return failureOutcome('CORE_STORAGE_UNAVAILABLE');
    }
    query = raw as unknown as CoreQuery;
  } catch {
    return failureOutcome('CORE_STORAGE_UNAVAILABLE');
  }
  let context: string | undefined;
  if (query.sessionId) {
    try {
      const session = await readCoreSession(key, record.owner, query.sessionId);
      if (!session) return failureOutcome('CORE_SESSION_NOT_FOUND');
      const turns = await readCoreSessionTurns(key, record.owner, query.sessionId);
      context = renderCoreSession(query.sessionId, session, turns);
    } catch {
      return failureOutcome('CORE_STORAGE_UNAVAILABLE');
    }
  }
  let answer: string;
  try {
    if (hasUnsafeBlockingConditions()) return failureOutcome('CORE_UNAVAILABLE');
    const { client } = getOpenAIClientOrAdapter();
    if (!client) return failureOutcome('CORE_PROVIDER_UNAVAILABLE');
    signal?.throwIfAborted();
    const result = await runWithSessionContext(context, () => runArcanosCoreQuery({
      client, gptId: CORE_GPT_ID, moduleId: 'ARCANOS:CORE', requestedAction: 'query', requestId: jobId,
      prompt: query.prompt, sourceEndpoint: CORE_GPT_JOB_PATH, maxOutputTokens: query.maxOutputTokens,
      executionModeOverride: 'background', executionModeReason: CORE_GPT_JOB_REASON, allowTimeoutFallback: false,
      runOptions: {
        answerMode: query.answerMode,
        disableMemoryAccess: true,
        disableOptionalSideEffects: true,
        redactAuditContent: true,
      },
    }));
    signal?.throwIfAborted();
    if (result.timeoutKind) return failureOutcome('CORE_GENERATION_TIMEOUT');
    if (result.dryRun || result.fallbackFlag || result.fallbackSummary?.finalFallbackUsed
      || !result.result.trim() || result.result.length > MAX_ANSWER_CHARS) return failureOutcome('CORE_GENERATION_FAILED');
    answer = sanitizeCoreText(result.result, key).trim();
    if (answer === '[REDACTED]') return failureOutcome('CORE_GENERATION_FAILED');
  } catch (error) {
    if (signal?.aborted) return failureOutcome('CORE_JOB_CANCELLED');
    if (isRecord(error) && error.code === 'TRINITY_CONTROL_LEAK') return failureOutcome('CORE_OPERATION_DENIED');
    if (isAbortError(error) || (error instanceof Error && /timeout|timed out/iu.test(error.message))) {
      return failureOutcome('CORE_GENERATION_TIMEOUT');
    }
    return failureOutcome('CORE_GENERATION_FAILED');
  }
  // The claimed terminal update commits the answer and this continuity turn
  // together. No uncommitted, failed or cancelled job can become history.
  const result: CoreCompletedAnswer = {
    answer,
    ...(query.sessionId ? { sessionId: query.sessionId, continuitySaved: true } : {}),
  };
  if (signal?.aborted) return failureOutcome('CORE_JOB_CANCELLED');
  try {
    return {
      status: 'completed' as const,
      output: { version: 1, envelope: sealCoreRecord(key, 'job-output', record.owner, jobId, result) },
      retryable: false,
    };
  } catch {
    return failureOutcome('CORE_STORAGE_UNAVAILABLE');
  }
}
