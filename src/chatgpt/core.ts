import { getRequestAbortSignal } from '@arcanos/runtime';
import { IdempotencyKeyConflictError } from '@core/db/repositories/jobRepository.js';
import {
  CORE_MEMORY_READ_SCOPE, CORE_MEMORY_WRITE_SCOPE, CORE_MCP_PATH,
  coreMcpToolScope, isCoreMcpInput, isCoreMcpToolName, type CoreMcpInputs, type CoreMcpToolName,
} from '@shared/chatgpt/coreMcpContract.js';
import { CORE_GPT_ID } from '@shared/chatgpt/coreJob.js';
import { inspectChatGptCoreDiagnostics } from '@services/chatgptCoreDiagnostics.js';
import { inspectChatGptCoreProductivity } from '@services/chatgptCoreProductivity.js';
import { enqueueCoreQuery, getCoreJobResult } from '@services/chatgptCoreJobs.js';
import {
  appendCoreNote, findCoreNote, readCoreSession, startCoreSession,
} from '@services/chatgptCoreSession.js';
import { resolveCoreStorageKey } from '@services/chatgptCoreStorage.js';
import { sanitizeCoreText } from '@services/chatgptCorePrivacy.js';
import {
  buildConfirmationRequestFingerprintHash, createConfirmationChallenge, verifyConfirmationChallenge,
} from '@transport/http/middleware/confirmationChallengeStore.js';
import type { ChatGptPrincipal } from './auth.js';
import { corePrincipalActorKey, hasCorePermission } from './coreAuth.js';

const errorMessages = {
  CORE_CONFIRMATION_REQUIRED: 'Confirm this exact Core memory save, then return the issued confirmation token.',
  CORE_IDEMPOTENCY_CONFLICT: 'This idempotency key already identifies a different request.',
  CORE_INPUT_INVALID: 'The Core request is invalid.',
  CORE_MEMORY_LIMIT_REACHED: 'This Core session has reached its saved-note limit.',
  CORE_PERMISSION_DENIED: 'The requested Core permission is required.',
  CORE_PRODUCTIVITY_UNAVAILABLE: 'Core productivity reads are unavailable.',
  CORE_SENSITIVE_INPUT: 'Remove credential-shaped data from the request and try again.',
  CORE_SESSION_NOT_FOUND: 'The Core session is unavailable.',
  CORE_STORAGE_UNAVAILABLE: 'Core storage is unavailable.',
  CORE_UNAVAILABLE: 'The Core operation could not be completed.',
} as const;

type CoreErrorCode = keyof typeof errorMessages;

function failure(code: CoreErrorCode) {
  return { ok: false as const, error: { code, message: errorMessages[code] } };
}

function checkInputText(value: string, key: Buffer): string {
  const text = value.trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error('CORE_INPUT_INVALID');
  }
  if (sanitizeCoreText(text, key) !== text) throw new Error('CORE_SENSITIVE_INPUT');
  return text;
}

async function saveConfirmedNote(key: Buffer, owner: string, input: CoreMcpInputs['writeCoreMemory']) {
  const { idempotencyKey, sessionId, confirmationToken } = input;
  const text = checkInputText(input.text, key);
  const session = await readCoreSession(key, owner, sessionId);
  if (!session) return failure('CORE_SESSION_NOT_FOUND');
  const prior = findCoreNote(session, idempotencyKey);
  if (prior) {
    return prior.text === text ? { ok: true as const, sessionId } : failure('CORE_IDEMPOTENCY_CONFLICT');
  }

  const confirmationPath = `${CORE_MCP_PATH}/writeCoreMemory`;
  const fingerprint = buildConfirmationRequestFingerprintHash({ sessionId, text, idempotencyKey });
  const binding = { actorKey: owner, principalId: owner, workspaceId: CORE_GPT_ID };
  if (!confirmationToken || !verifyConfirmationChallenge(confirmationToken, 'POST', confirmationPath, fingerprint, binding)) {
    const challenge = createConfirmationChallenge('POST', confirmationPath, CORE_GPT_ID, fingerprint, binding);
    return {
      ...failure('CORE_CONFIRMATION_REQUIRED'),
      confirmationToken: challenge.id,
      confirmationExpiresAt: new Date(challenge.expiresAt).toISOString(),
    };
  }
  return await appendCoreNote(key, owner, sessionId, idempotencyKey, text)
    ? { ok: true as const, sessionId } : failure('CORE_SESSION_NOT_FOUND');
}

/** Execute only the authorized, fixed Core tools admitted by the dedicated OAuth verifier. */
export async function executeCoreMcp(
  principal: ChatGptPrincipal, name: CoreMcpToolName, input: unknown,
  { requestId }: { requestId?: string; traceId?: string } = {},
) {
  if (!isCoreMcpToolName(name) || !hasCorePermission(principal, coreMcpToolScope(name))) {
    return failure('CORE_PERMISSION_DENIED');
  }
  if (!isCoreMcpInput(name, input)) return failure('CORE_INPUT_INVALID');
  getRequestAbortSignal()?.throwIfAborted();
  const owner = corePrincipalActorKey(principal);
  const canReadSession = () => hasCorePermission(principal, CORE_MEMORY_READ_SCOPE);
  try {
    if (name === 'inspectCoreDiagnostics') {
      const args = input as CoreMcpInputs['inspectCoreDiagnostics'];
      return { ok: true as const, ...await inspectChatGptCoreDiagnostics(args.area) };
    }
    if (name === 'readCoreProductivity') {
      const args = input as CoreMcpInputs['readCoreProductivity'];
      const result = await inspectChatGptCoreProductivity(args.view, owner);
      return result ? { ok: true as const, ...result } : failure('CORE_PRODUCTIVITY_UNAVAILABLE');
    }

    const key = resolveCoreStorageKey();
    switch (name) {
      case 'coreAsk': {
        const args = input as CoreMcpInputs['coreAsk'];
        if (args.sessionId && (!canReadSession() || !hasCorePermission(principal, CORE_MEMORY_WRITE_SCOPE))) {
          return failure('CORE_PERMISSION_DENIED');
        }
        const prompt = checkInputText(args.prompt, key);
        if (args.sessionId && !await readCoreSession(key, owner, args.sessionId)) {
          return failure('CORE_SESSION_NOT_FOUND');
        }
        const jobId = await enqueueCoreQuery(key, owner, { ...args, prompt }, requestId);
        return await getCoreJobResult(key, owner, jobId, canReadSession, true);
      }
      case 'getCoreJobResult': {
        const { jobId } = input as CoreMcpInputs['getCoreJobResult'];
        return await getCoreJobResult(key, owner, jobId, canReadSession);
      }
      case 'startCoreSession': {
        const { idempotencyKey } = input as CoreMcpInputs['startCoreSession'];
        return { ok: true as const, sessionId: await startCoreSession(key, owner, idempotencyKey) };
      }
      case 'readCoreMemory': {
        const { sessionId } = input as CoreMcpInputs['readCoreMemory'];
        const session = await readCoreSession(key, owner, sessionId);
        return session
          ? { ok: true as const, sessionId, notes: session.notes.map(note => note.text) }
          : failure('CORE_SESSION_NOT_FOUND');
      }
      case 'writeCoreMemory':
        return await saveConfirmedNote(key, owner, input as CoreMcpInputs['writeCoreMemory']);
    }
  } catch (error) {
    getRequestAbortSignal()?.throwIfAborted();
    if (error instanceof IdempotencyKeyConflictError) return failure('CORE_IDEMPOTENCY_CONFLICT');
    if (error instanceof Error && Object.hasOwn(errorMessages, error.message)) {
      return failure(error.message as CoreErrorCode);
    }
    return failure('CORE_UNAVAILABLE');
  }
}
