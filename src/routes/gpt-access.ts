import express from 'express';

import { writePublicHealthResponse } from '@core/diagnostics.js';
import {
  getRequestActorKey,
  getRequestAuthenticatedActorKey,
  securityHeaders
} from '@platform/runtime/security.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import type { ConfirmationChallengeBinding } from '@transport/http/middleware/confirmationChallengeStore.js';
import {
  DISPATCH_RUN_BODY_KEYS,
  DISPATCH_UTTERANCE_MAX_LENGTH,
  createGptAccessDispatchRegistry,
  isUnsafeGptAccessPayloadKey,
  readDispatchConfirmationTokenField,
  runDispatchPlan,
  stripDispatchConfirmationToken,
  type DispatchExecutionResult,
  type DispatchPolicyDecision,
  type DispatchPlan
} from '@dispatcher/naturalLanguage/index.js';
import { isModuleActionAllowed } from '../mcp/modulesAllowlist.js';
import {
  dispatchModuleAction,
  getModuleMetadata,
  getModulesForRegistry,
  initializeModuleRegistry,
  ModuleActionNotFoundError,
  ModuleNotFoundError
} from '@services/moduleRegistry.js';
import ArcanosCli from '@services/arcanos-cli.js';
import { MODULE_CATALOG } from '@services/moduleCatalog.js';
import {
  asyncHandler,
  noStoreResponse,
  sendBadRequestPayload,
  sendInternalErrorPayload
} from '@shared/http/index.js';
import { throwIfRequestAborted } from '@arcanos/runtime';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';
import type { ModuleHandlerContext } from '@services/moduleLoader.js';
import {
  isBackstageRosterPersistenceError,
  isBackstageRosterValidationError
} from '@shared/backstage/backstageRoster.js';
import {
  type BackstageStorylineValidationError,
  isBackstageStorylineValidationError,
  parseBackstageStorylinePayload
} from '@shared/backstage/backstageStoryline.js';
import { BACKSTAGE_MODULE_NAME } from '@shared/backstage/backstageActionPolicy.js';
import {
  isResearchRequestValidationError,
  normalizeResearchModulePayload,
  RESEARCH_ACTION_NAME,
  RESEARCH_MODULE_NAME,
  type ResearchRequestValidationError,
} from '@shared/researchRequest.js';
import { getWorkerControlHealth, getWorkerControlStatus } from '@services/workerControlService.js';
import {
  buildGptAccessHealthPayload,
  buildGptAccessOpenApiDocument,
  createGptAccessAiJob,
  getGptAccessQueueInspection,
  getGptAccessSelfHealStatus,
  explainApprovedQuery,
  getGptAccessJobResult,
  gptAccessAuthMiddleware,
  queryBackendLogs,
  queryJobEventTimeline,
  requireGptAccessScope,
  resolveGptAccessOpenApiServerUrl,
  runDeepDiagnostics,
  runGptAccessWorkerRecovery,
  runGptAccessMcpTool,
  sanitizeGptAccessPayload,
  sendGptAccessResult,
} from '@services/gptAccessGateway.js';
import {
  isArcanosCliReadOnlyAction,
  isArcanosCliBridgeEnabled
} from '@services/arcanosCliBridge.js';
import {
  buildDispatchPolicyBlockPayload,
  resolveGptAccessNaturalLanguageDispatch,
  toDispatchPolicyResponse
} from '@services/gptAccessNaturalLanguageDispatch.js';
import localAgentProtocolRouter from './gpt-access-local-agent.js';
import { configureLocalAgentActionExecutor } from '@services/localAgent/executor.js';
import { executeLocalAgentActionAsJob } from '@services/localAgent/service.js';
import {
  createGamingSourceIngestion,
  getGamingSourceIngestionStatus,
  refreshGamingSources
} from '@services/gamingSourceIngestion.js';
import {
  gamingSourceHttpBoundary,
  isGamingSourceHttpBoundaryApplied,
} from '@services/gamingSourceHttpBoundary.js';
import { gamingSourceBodyParser } from '@services/gamingSourceBodyParser.js';
import { requireGamingSourceAccessAuthentication } from '@services/gamingSourceAccessAuth.js';
import { gptAccessRateLimit } from '@services/gptAccessRateLimit.js';

const router = express.Router();
configureLocalAgentActionExecutor(executeLocalAgentActionAsJob);

type CapabilityRegistryEntry = ReturnType<typeof getModulesForRegistry>[number];
type CapabilityMetadata = NonNullable<ReturnType<typeof getModuleMetadata>>;
type CapabilityRunBody =
  | { ok: true; action: unknown; payload: unknown }
  | { ok: false; message: string };
type DispatchRunBody =
  | {
      ok: true;
      utterance: string;
      context?: Record<string, unknown>;
      dryRun: boolean;
    }
  | { ok: false; message: string };

const CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY = 'confirmation_token';
const CAPABILITY_CONFIRMATION_HEADER_TOKEN_PREFIX = 'token:';
const CAPABILITY_RUN_BODY_KEYS = new Set(['action', 'payload']);
const CAPABILITY_PAYLOAD_MAX_DEPTH = 32;
const CAPABILITY_IDEMPOTENCY_KEY_MAX_LENGTH = 240;
const CAPABILITY_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/u;
const GPT_ACCESS_CONTEXT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const CORE_CAPABILITY_ID = 'ARCANOS:CORE';
const CORE_CAPABILITY_ROUTE = 'core';
const CORE_READONLY_ACTIONS = new Set(['system_state']);
const CLI_CATALOG_ENTRY = MODULE_CATALOG.find(
  (entry) => entry.name === ArcanosCli.name
);
if (!CLI_CATALOG_ENTRY || CLI_CATALOG_ENTRY.gptAccessOnly !== true) {
  throw new Error('ARCANOS CLI catalog registration is unavailable.');
}
const CLI_CAPABILITY_ID = ArcanosCli.name;
const CLI_CAPABILITY_ROUTE = CLI_CATALOG_ENTRY.route;
const CLI_CAPABILITY_ACTIONS = Object.freeze(Object.keys(ArcanosCli.actions));
const LOCAL_AGENT_CAPABILITY_ID = 'ARCANOS:LOCAL_AGENT';
const LOCAL_AGENT_CAPABILITY_ROUTE = 'local-agent';
const LOCAL_AGENT_STRICT_CONFIRMATION_ACTIONS = new Set([
  'tests.run',
  'patch.apply'
]);
function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function isCliCapabilityId(value: string): boolean {
  return value === CLI_CAPABILITY_ID || value === CLI_CAPABILITY_ROUTE;
}

function isCoreCapabilityId(value: string): boolean {
  return value === CORE_CAPABILITY_ID || value === CORE_CAPABILITY_ROUTE;
}

function readConfiguredGptAccessContextId(name: string): string | null {
  const value = process.env[name];
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || !GPT_ACCESS_CONTEXT_ID_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function readCapabilityIdempotencyKey(req: express.Request): string | undefined {
  const value = req.header('idempotency-key');
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > 0
    && value.length <= CAPABILITY_IDEMPOTENCY_KEY_MAX_LENGTH
    && CAPABILITY_IDEMPOTENCY_KEY_PATTERN.test(value)
    ? value
    : undefined;
}

function validateCapabilityIdempotencyKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (
    req.header('idempotency-key') !== undefined
    && readCapabilityIdempotencyKey(req) === undefined
  ) {
    sendGptAccessBadRequest(
      res,
      `idempotency-key must be 1-${CAPABILITY_IDEMPOTENCY_KEY_MAX_LENGTH} visible ASCII characters.`
    );
    return;
  }
  next();
}

function buildGptAccessModuleHandlerContext(
  req: express.Request
): ModuleHandlerContext | null {
  const principalId = readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_PRINCIPAL_ID');
  const workspaceId = readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_WORKSPACE_ID');
  if (!principalId || !workspaceId) {
    return null;
  }

  const idempotencyKey = readCapabilityIdempotencyKey(req);
  return {
    source: 'gpt-access',
    principalId,
    workspaceId,
    actorKey: getRequestActorKey(req),
    ...(req.requestId ? { requestId: req.requestId } : {}),
    traceId: req.traceId ?? null,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(req.confirmationContext
      ? {
          confirmation: {
            status: req.confirmationContext.confirmationStatus,
            usedChallengeToken: req.confirmationContext.usedChallengeToken
          }
        }
      : {})
  };
}

function buildGptAccessConfirmationBinding(
  req: express.Request
): ConfirmationChallengeBinding {
  return {
    actorKey: getRequestAuthenticatedActorKey(req),
    principalId:
      readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_PRINCIPAL_ID')
      ?? 'gpt-access:unscoped-principal',
    workspaceId:
      readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_WORKSPACE_ID')
      ?? 'gpt-access:unscoped-workspace'
  };
}

function isExplicitReadOnlyCapabilityAction(
  metadata: CapabilityMetadata | null,
  action: string
): boolean {
  const candidate = metadata?.actionMetadata?.[action] as
    | { risk?: unknown; requiresConfirmation?: unknown }
    | undefined;
  return Boolean(
    candidate
    && candidate.risk === 'readonly'
    && (
      candidate.requiresConfirmation === undefined
      || typeof candidate.requiresConfirmation === 'boolean'
    )
    && candidate.requiresConfirmation !== true
  );
}

function isReadOnlySystemStatePayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return true;
  }

  const record = value as Record<string, unknown>;
  return !Object.prototype.hasOwnProperty.call(record, 'patch')
    && !Object.prototype.hasOwnProperty.call(record, 'expectedVersion');
}

function getCliCapabilitySummary() {
  return {
    id: CLI_CAPABILITY_ID,
    enabled: isArcanosCliBridgeEnabled(),
    description: ArcanosCli.description ?? null,
    route: CLI_CAPABILITY_ROUTE,
    actions: sortStrings(CLI_CAPABILITY_ACTIONS)
  };
}

function getCliCapabilityDetail() {
  return {
    id: CLI_CAPABILITY_ID,
    name: CLI_CAPABILITY_ID,
    enabled: isArcanosCliBridgeEnabled(),
    description: ArcanosCli.description ?? null,
    route: CLI_CAPABILITY_ROUTE,
    actions: sortStrings(CLI_CAPABILITY_ACTIONS),
    defaultAction: ArcanosCli.defaultAction ?? null,
    defaultTimeoutMs: ArcanosCli.defaultTimeoutMs ?? null
  };
}

function toCapabilitySummary(entry: CapabilityRegistryEntry) {
  const summary = {
    id: entry.id,
    description: entry.description ?? null,
    route: entry.route ?? null,
    actions: sortStrings(entry.actions)
  };
  return entry.id === CLI_CAPABILITY_ID
    ? { ...summary, enabled: isArcanosCliBridgeEnabled() }
    : summary;
}

function toCapabilityDetail(metadata: CapabilityMetadata) {
  const detail = {
    id: metadata.name,
    name: metadata.name,
    description: metadata.description ?? null,
    route: metadata.route ?? null,
    actions: sortStrings(metadata.actions),
    actionMetadata: metadata.actionMetadata,
    defaultAction: metadata.defaultAction ?? null,
    defaultTimeoutMs: metadata.defaultTimeoutMs ?? null
  };
  return metadata.name === CLI_CAPABILITY_ID
    ? { ...detail, enabled: isArcanosCliBridgeEnabled() }
    : detail;
}

function findUnsafeCapabilityPayloadIssue(
  value: unknown,
  depth = 0,
  options: { allowCliCommandFields?: boolean } = {}
): 'unsafe_field' | 'depth_exceeded' | null {
  if (depth > CAPABILITY_PAYLOAD_MAX_DEPTH) {
    return 'depth_exceeded';
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const issue = findUnsafeCapabilityPayloadIssue(item, depth + 1, options);
      if (issue) return issue;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const isCliCommandField = options.allowCliCommandFields
      && ['command', 'cwd', 'timeoutMs', 'patch'].includes(key);
    if (key.trim().toLowerCase() === CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY) {
      return 'unsafe_field';
    }
    if (!isCliCommandField && isUnsafeGptAccessPayloadKey(key)) {
      return 'unsafe_field';
    }

    const issue = findUnsafeCapabilityPayloadIssue(record[key], depth + 1, options);
    if (issue) return issue;
  }

  return null;
}

function readCapabilityRunBody(body: unknown): CapabilityRunBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object.' };
  }

  const record = body as Record<string, unknown>;
  const unsupportedKey = Object.keys(record).find((key) => !CAPABILITY_RUN_BODY_KEYS.has(key));
  if (unsupportedKey) {
    return { ok: false, message: 'request body may only include action and payload.' };
  }

  const payload = Object.prototype.hasOwnProperty.call(record, 'payload') ? record.payload : {};
  const allowCliCommandFields =
    typeof record.action === 'string'
    && ['proposeCommand', 'runApprovedCommand', 'proposePatch', 'applyApprovedPatch'].includes(record.action.trim());
  const payloadIssue = findUnsafeCapabilityPayloadIssue(payload, 0, { allowCliCommandFields });
  if (payloadIssue === 'unsafe_field') {
    return { ok: false, message: 'payload contains fields that are not allowed for capability execution.' };
  }
  if (payloadIssue === 'depth_exceeded') {
    return { ok: false, message: 'payload exceeds maximum nesting depth for capability execution.' };
  }

  return {
    ok: true,
    action: record.action,
    payload
  };
}

function capabilityRunNeedsConfirmation(req: express.Request): boolean {
  if (isCoreCapabilityId(req.params.id)) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return true;
    }

    const record = req.body as Record<string, unknown>;
    const action = record.action;
    const payload = Object.prototype.hasOwnProperty.call(record, 'payload') ? record.payload : {};
    if (
      typeof action === 'string'
      && CORE_READONLY_ACTIONS.has(action.trim())
      && isReadOnlySystemStatePayload(payload)
    ) {
      return false;
    }

    return true;
  }

  if (!isCliCapabilityId(req.params.id)) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return true;
    }
    const action = (req.body as Record<string, unknown>).action;
    if (typeof action !== 'string' || action.trim().length === 0) {
      return true;
    }
    try {
      return !isExplicitReadOnlyCapabilityAction(
        getModuleMetadata(req.params.id),
        action.trim()
      );
    } catch {
      return true;
    }
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return true;
  }

  const action = (req.body as Record<string, unknown>).action;
  return typeof action !== 'string' || !isArcanosCliReadOnlyAction(action);
}

function cliActionNeedsModuleAllowlist(moduleName: string, action: string): boolean {
  return moduleName !== CLI_CAPABILITY_ID || !isArcanosCliReadOnlyAction(action);
}

function confirmCapabilityRunWhenRequired(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!capabilityRunNeedsConfirmation(req)) {
    next();
    return;
  }

  const capabilityId = req.params.id;
  const action = req.body
    && typeof req.body === 'object'
    && !Array.isArray(req.body)
    && typeof (req.body as Record<string, unknown>).action === 'string'
    ? ((req.body as Record<string, unknown>).action as string).trim()
    : null;
  const strictLocalAgentConfirmation =
    (capabilityId === LOCAL_AGENT_CAPABILITY_ID
      || capabilityId === LOCAL_AGENT_CAPABILITY_ROUTE)
    && action !== null
    && LOCAL_AGENT_STRICT_CONFIRMATION_ACTIONS.has(action);
  const strictConfirmationBinding: ConfirmationChallengeBinding | null =
    strictLocalAgentConfirmation
      ? (() => {
          const principalId = readConfiguredGptAccessContextId(
            'ARCANOS_GPT_ACCESS_PRINCIPAL_ID'
          );
          const workspaceId = readConfiguredGptAccessContextId(
            'ARCANOS_GPT_ACCESS_WORKSPACE_ID'
          );
          return principalId && workspaceId
            ? {
                actorKey: getRequestAuthenticatedActorKey(req),
                principalId,
                workspaceId
              }
            : null;
        })()
      : null;
  if (strictLocalAgentConfirmation && !strictConfirmationBinding) {
    sendGptAccessUnavailable(
      res,
      'GPT_ACCESS_CONTEXT_UNAVAILABLE',
      'GPT Access confirmation identity is unavailable.'
    );
    return;
  }

  confirmGate(req, res, () => {
    if (
      strictLocalAgentConfirmation
      && req.confirmationContext?.usedChallengeToken !== true
    ) {
      res.status(403).json({
        ok: false,
        error: {
          code: 'LOCAL_AGENT_CHALLENGE_CONFIRMATION_REQUIRED',
          message:
            `${action} requires a consumed confirmation challenge bound to this exact action and payload.`
        },
        confirmationRequired: true,
        confirmationStatus: req.confirmationContext?.confirmationStatus ?? 'missing',
        ...(req.requestId ? { requestId: req.requestId } : {}),
        ...(req.traceId ? { traceId: req.traceId } : {})
      });
      return;
    }
    next();
  }, strictConfirmationBinding
    ? {
        challengeBinding: strictConfirmationBinding,
        requireChallengeToken: true
      }
    : {});
}

function preflightResearchCapabilityRun(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.params.id !== RESEARCH_MODULE_NAME && req.params.id !== 'research') {
    next();
    return;
  }

  const body = readCapabilityRunBody(req.body);
  if (!body.ok || typeof body.action !== 'string') {
    next();
    return;
  }

  let metadata: CapabilityMetadata | null;
  try {
    metadata = getModuleMetadata(req.params.id);
  } catch {
    next();
    return;
  }
  if (
    metadata?.name !== RESEARCH_MODULE_NAME
    || body.action.trim() !== RESEARCH_ACTION_NAME
  ) {
    next();
    return;
  }

  try {
    normalizeResearchModulePayload(body.payload);
    next();
  } catch (error: unknown) {
    if (!isResearchRequestValidationError(error)) {
      throw error;
    }

    sendGptAccessResult(res, {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: error.message,
        },
      },
    });
  }
}

function preflightBackstageStorylineCapabilityRun(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (
    req.params.id !== BACKSTAGE_MODULE_NAME
    && req.params.id !== 'backstage-booker'
    && req.params.id !== 'backstage'
  ) {
    next();
    return;
  }

  const body = readCapabilityRunBody(req.body);
  if (!body.ok || typeof body.action !== 'string') {
    next();
    return;
  }

  let metadata: CapabilityMetadata | null;
  try {
    metadata = getModuleMetadata(req.params.id);
  } catch {
    next();
    return;
  }
  if (
    metadata?.name !== BACKSTAGE_MODULE_NAME
    || body.action.trim() !== 'trackStoryline'
  ) {
    next();
    return;
  }

  try {
    const normalizedPayload = parseBackstageStorylinePayload(body.payload);
    (req.body as Record<string, unknown>).payload = normalizedPayload;
    next();
  } catch (error: unknown) {
    if (!isBackstageStorylineValidationError(error)) {
      throw error;
    }

    sendGptAccessResult(res, {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: error.message,
        },
      },
    });
  }
}

function resolveResearchDispatchValidationError(
  plan: DispatchPlan,
  policy: DispatchPolicyDecision,
): ResearchRequestValidationError | null {
  const runner = policy.registryAction?.runner;
  if (
    runner?.kind !== 'gpt-access-capability'
    || runner.capabilityAction !== RESEARCH_ACTION_NAME
  ) {
    return null;
  }

  let metadata: CapabilityMetadata | null;
  try {
    metadata = getModuleMetadata(runner.capabilityId);
  } catch {
    return null;
  }
  if (metadata?.name !== RESEARCH_MODULE_NAME) {
    return null;
  }

  try {
    normalizeResearchModulePayload(plan.payload);
    return null;
  } catch (error: unknown) {
    if (!isResearchRequestValidationError(error)) {
      throw error;
    }
    return error;
  }
}

function resolveBackstageStorylineDispatchValidationError(
  plan: DispatchPlan,
  policy: DispatchPolicyDecision,
): BackstageStorylineValidationError | null {
  const runner = policy.registryAction?.runner;
  if (
    runner?.kind !== 'gpt-access-capability'
    || runner.capabilityAction !== 'trackStoryline'
  ) {
    return null;
  }

  let metadata: CapabilityMetadata | null;
  try {
    metadata = getModuleMetadata(runner.capabilityId);
  } catch {
    return null;
  }
  if (metadata?.name !== BACKSTAGE_MODULE_NAME) {
    return null;
  }

  try {
    plan.payload = parseBackstageStorylinePayload(plan.payload);
    return null;
  } catch (error: unknown) {
    if (!isBackstageStorylineValidationError(error)) {
      throw error;
    }
    return error;
  }
}

function readDispatchRunBody(body: unknown): DispatchRunBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object.' };
  }

  const record = body as Record<string, unknown>;
  const unsupportedKey = Object.keys(record).find((key) => !DISPATCH_RUN_BODY_KEYS.has(key));
  if (unsupportedKey) {
    return {
      ok: false,
      message: 'request body may only include utterance, context, dryRun, and confirmation_token.'
    };
  }

  if (typeof record.utterance !== 'string' || record.utterance.trim().length === 0) {
    return { ok: false, message: 'utterance must be a non-empty string.' };
  }

  const utterance = record.utterance.trim();
  if (utterance.length > DISPATCH_UTTERANCE_MAX_LENGTH) {
    return {
      ok: false,
      message: `utterance must be ${DISPATCH_UTTERANCE_MAX_LENGTH} characters or fewer.`
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(record, 'context')
    && (!record.context || typeof record.context !== 'object' || Array.isArray(record.context))
  ) {
    return { ok: false, message: 'context must be a JSON object when provided.' };
  }

  if (
    Object.prototype.hasOwnProperty.call(record, 'dryRun')
    && typeof record.dryRun !== 'boolean'
  ) {
    return { ok: false, message: 'dryRun must be a boolean when provided.' };
  }

  return {
    ok: true,
    utterance,
    context: record.context as Record<string, unknown> | undefined,
    dryRun: record.dryRun === true
  };
}

function readCapabilityConfirmationTokenField(value: unknown):
  | { ok: true; confirmationChallengeId: string }
  | { ok: false; message: string } {
  if (typeof value !== 'string') {
    return { ok: false, message: 'confirmation_token must be a non-empty string when provided.' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'confirmation_token must be a non-empty string when provided.' };
  }
  if (/[\r\n\u0000-\u001F\u007F]/u.test(trimmed)) {
    return { ok: false, message: 'confirmation_token must be a single non-empty token value.' };
  }

  const confirmationChallengeId = trimmed.toLowerCase().startsWith(CAPABILITY_CONFIRMATION_HEADER_TOKEN_PREFIX)
    ? trimmed.slice(CAPABILITY_CONFIRMATION_HEADER_TOKEN_PREFIX.length).trim()
    : trimmed;

  if (confirmationChallengeId.length === 0 || /\s/u.test(confirmationChallengeId)) {
    return { ok: false, message: 'confirmation_token must be a single non-empty token value.' };
  }

  return { ok: true, confirmationChallengeId };
}

function normalizeCapabilityRunBodyForConfirmation(record: Record<string, unknown>): Record<string, unknown> {
  const bodyKeys = Object.keys(record);
  const onlySupportedRunKeys = bodyKeys.every((key) => CAPABILITY_RUN_BODY_KEYS.has(key));
  if (
    onlySupportedRunKeys
    && Object.prototype.hasOwnProperty.call(record, 'action')
    && !Object.prototype.hasOwnProperty.call(record, 'payload')
  ) {
    return {
      ...record,
      payload: {}
    };
  }

  return record;
}

function mapCapabilityRunConfirmationToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    next();
    return;
  }

  const record = req.body as Record<string, unknown>;
  const hasConfirmationToken = Object.prototype.hasOwnProperty.call(
    record,
    CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY
  );
  const sanitizedBody = hasConfirmationToken ? { ...record } : record;
  if (hasConfirmationToken) {
    delete sanitizedBody[CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY];
  }

  req.body = normalizeCapabilityRunBodyForConfirmation(sanitizedBody);

  if (!hasConfirmationToken) {
    next();
    return;
  }

  const tokenResult = readCapabilityConfirmationTokenField(record[CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY]);

  if (!tokenResult.ok) {
    sendGptAccessBadRequest(res, tokenResult.message);
    return;
  }

  if (!req.header('x-confirmed')) {
    req.headers['x-confirmed'] = `token:${tokenResult.confirmationChallengeId}`;
  }

  next();
}

function mapDispatchRunConfirmationToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    next();
    return;
  }

  const { body, confirmationToken } = stripDispatchConfirmationToken(req.body as Record<string, unknown>);
  req.body = body;

  if (confirmationToken === undefined) {
    next();
    return;
  }

  const tokenResult = readDispatchConfirmationTokenField(confirmationToken);
  if (!tokenResult.ok) {
    sendGptAccessBadRequest(res, tokenResult.message);
    return;
  }

  if (!req.header('x-confirmed')) {
    req.headers['x-confirmed'] = `token:${tokenResult.confirmationChallengeId}`;
  }

  next();
}

function sendGptAccessBadRequest(res: express.Response, message: string): void {
  sendBadRequestPayload(res, {
    ok: false,
    error: {
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message
    }
  });
}

function sendGptAccessInternalError(res: express.Response, message: string): void {
  sendInternalErrorPayload(res, {
    ok: false,
    error: {
      code: 'GPT_ACCESS_INTERNAL_ERROR',
      message
    }
  });
}

function sendGptAccessUnavailable(
  res: express.Response,
  code: string,
  message: string
): void {
  sendGptAccessResult(res, {
    statusCode: 503,
    payload: {
      ok: false,
      status: 'unavailable',
      service: 'gpt-access',
      error: {
        code,
        message
      }
    }
  });
}

async function requireGptAccessModuleRegistry(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    await initializeModuleRegistry();
    next();
  } catch {
    sendGptAccessUnavailable(
      res,
      'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
      'Capability registry is unavailable.'
    );
  }
}

function isModuleDispatchNotFoundError(error: unknown): boolean {
  return error instanceof ModuleNotFoundError || error instanceof ModuleActionNotFoundError;
}

const listGptAccessCapabilities = asyncHandler(async (_req, res) => {
  let capabilities;
  try {
    capabilities = getModulesForRegistry()
      .map(toCapabilitySummary)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (
      !capabilities.some((capability) => capability.id === CLI_CAPABILITY_ID)
    ) {
      capabilities.push(getCliCapabilitySummary());
      capabilities.sort((left, right) => left.id.localeCompare(right.id));
    }
  } catch {
    sendGptAccessUnavailable(
      res,
      'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
      'Capability registry is unavailable.'
    );
    return;
  }

  res.json({
    ok: true,
    capabilities
  });
});

const getGptAccessCapability = asyncHandler(async (req, res) => {
  if (isCliCapabilityId(req.params.id)) {
    res.json({
      ok: true,
      exists: true,
      capability: getCliCapabilityDetail()
    });
    return;
  }

  let metadata;
  try {
    metadata = getModuleMetadata(req.params.id);
  } catch {
    sendGptAccessUnavailable(
      res,
      'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
      'Capability registry is unavailable.'
    );
    return;
  }

  if (!metadata) {
    res.json({
      ok: true,
      exists: false,
      capability: null
    });
    return;
  }

  res.json({
    ok: true,
    exists: true,
    capability: toCapabilityDetail(metadata)
  });
});

async function runGptAccessCapabilityAction(input: {
  capabilityId: string;
  action: string;
  payload: unknown;
  moduleContext?: ModuleHandlerContext | null;
}): Promise<DispatchExecutionResult> {
  let metadata;
  try {
    metadata = getModuleMetadata(input.capabilityId);
  } catch {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        status: 'unavailable',
        service: 'gpt-access',
        error: {
          code: 'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
          message: 'Capability registry is unavailable.'
        }
      }
    };
  }

  if (!metadata && isCliCapabilityId(input.capabilityId)) {
    return runFallbackArcanosCliCapabilityAction(input.action, input.payload);
  }

  if (!metadata) {
    return {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_CAPABILITY_NOT_FOUND',
          message: 'Capability not found.'
        }
      }
    };
  }

  if (!metadata.actions.includes(input.action)) {
    return {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_ACTION_NOT_FOUND',
          message: 'Capability action not found.'
        }
      }
    };
  }

  if (
    cliActionNeedsModuleAllowlist(metadata.name, input.action)
    && !isModuleActionAllowed(metadata.name, input.action)
  ) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
          message: 'Capability action is not allowlisted for GPT Access execution.'
        }
      }
    };
  }

  if (metadata.gptAccessOnly === true && !input.moduleContext) {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        status: 'unavailable',
        service: 'gpt-access',
        error: {
          code: 'GPT_ACCESS_INTERNAL_ERROR',
          message: 'GPT Access capability execution identity is unavailable.'
        }
      }
    };
  }

  try {
    const result = metadata.gptAccessOnly === true
      ? await dispatchModuleAction(
          metadata.name,
          input.action,
          input.payload,
          input.moduleContext ?? undefined
        )
      : await dispatchModuleAction(metadata.name, input.action, input.payload);
    return {
      statusCode: 200,
      payload: {
        ok: true,
        result: sanitizeGptAccessPayload(result)
      }
    };
  } catch (error) {
    if (isModuleDispatchNotFoundError(error)) {
      return {
        statusCode: 404,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_CAPABILITY_NOT_FOUND',
            message: 'Capability or action not found.'
          }
        }
      };
    }

    if (
      metadata.name === BACKSTAGE_MODULE_NAME
      && input.action === 'updateRoster'
      && isBackstageRosterValidationError(error)
    ) {
      return {
        statusCode: 400,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_VALIDATION_ERROR',
            message: error.message
          }
        }
      };
    }

    if (
      metadata.name === BACKSTAGE_MODULE_NAME
      && input.action === 'trackStoryline'
      && isBackstageStorylineValidationError(error)
    ) {
      return {
        statusCode: 400,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_VALIDATION_ERROR',
            message: error.message
          }
        }
      };
    }

    if (
      metadata.name === RESEARCH_MODULE_NAME
      && input.action === RESEARCH_ACTION_NAME
      && isResearchRequestValidationError(error)
    ) {
      return {
        statusCode: 400,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_VALIDATION_ERROR',
            message: error.message,
          },
        },
      };
    }

    if (
      metadata.name === BACKSTAGE_MODULE_NAME
      && input.action === 'updateRoster'
      && isBackstageRosterPersistenceError(error)
    ) {
      return {
        statusCode: 503,
        payload: {
          ok: false,
          error: {
            code: error.code,
            message: error.message
          }
        }
      };
    }

    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_INTERNAL_ERROR',
          message: 'Capability execution failed.'
        }
      }
    };
  }
}

async function runFallbackArcanosCliCapabilityAction(
  action: string,
  payload: unknown
): Promise<DispatchExecutionResult> {
  if (!CLI_CAPABILITY_ACTIONS.includes(action)) {
    return {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_ACTION_NOT_FOUND',
          message: 'Capability action not found.'
        }
      }
    };
  }

  if (
    cliActionNeedsModuleAllowlist(CLI_CAPABILITY_ID, action)
    && !isModuleActionAllowed(CLI_CAPABILITY_ID, action)
  ) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
          message: 'Capability action is not allowlisted for GPT Access execution.'
        }
      }
    };
  }

  try {
    return {
      statusCode: 200,
      payload: {
        ok: true,
        result: sanitizeGptAccessPayload(
          await ArcanosCli.actions[action]!(payload)
        )
      }
    };
  } catch {
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: 'ARCANOS CLI action payload is invalid or denied by policy.'
        }
      }
    };
  }
}

const runGptAccessCapability = asyncHandler(async (req, res) => {
  const body = readCapabilityRunBody(req.body);
  if (!body.ok) {
    sendGptAccessBadRequest(res, body.message);
    return;
  }

  const { action, payload } = body;

  if (typeof action !== 'string' || action.trim().length === 0) {
    sendGptAccessBadRequest(res, 'action must be a non-empty string.');
    return;
  }

  const abortScope = createClientDisconnectAbortScope(
    req,
    res,
    'GPT Access capability client disconnected',
  );
  try {
    const result = await abortScope.run(() => runGptAccessCapabilityAction({
      capabilityId: req.params.id,
      action: action.trim(),
      payload,
      moduleContext: buildGptAccessModuleHandlerContext(req)
    }));
    sendGptAccessResult(res, result);
  } finally {
    abortScope.cleanup();
  }
});

function sendDispatchPolicyBlock(
  res: express.Response,
  plan: DispatchPlan,
  policy: DispatchPolicyDecision
): void {
  const statusCode = policy.status === 'clarification_required' ? 422 : 403;
  sendGptAccessResult(res, {
    statusCode,
    payload: buildDispatchPolicyBlockPayload(plan, policy)
  });
}

async function executeDispatchRun(
  req: express.Request,
  res: express.Response,
  plan: DispatchPlan,
  policy: DispatchPolicyDecision
): Promise<void> {
  if (!policy.registryAction) {
    sendDispatchPolicyBlock(res, plan, policy);
    return;
  }

  const result = await runDispatchPlan({
    plan,
    registry: createGptAccessDispatchRegistry(
      getModulesForRegistry({ includeActionMetadata: true })
    ),
    handlers: {
      runMcpTool: (body) => runGptAccessMcpTool(body),
      runDiagnostics: (payload) => runDeepDiagnostics(payload),
      runWorkerRecovery: (payload) => runGptAccessWorkerRecovery(payload),
      runCapability: (input) => runGptAccessCapabilityAction({
        capabilityId: input.capabilityId,
        action: input.action,
        payload: input.payload,
        moduleContext: buildGptAccessModuleHandlerContext(req)
      })
    }
  });

  sendGptAccessResult(res, {
    statusCode: result.statusCode,
    payload: {
      ok: result.statusCode >= 200 && result.statusCode < 300,
      plan,
      policy: toDispatchPolicyResponse(policy),
      result: sanitizeGptAccessPayload(result.payload)
    }
  });
}

async function executeGptAccessDispatchRequest(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const body = readDispatchRunBody(req.body);
  if (!body.ok) {
    sendGptAccessBadRequest(res, body.message);
    return;
  }

  const registry = createGptAccessDispatchRegistry(
    getModulesForRegistry({ includeActionMetadata: true })
  );
  throwIfRequestAborted();
  const { plan, policy } = await resolveGptAccessNaturalLanguageDispatch({
    utterance: body.utterance,
    registry,
    context: body.context,
    isModuleActionAllowed
  });
  throwIfRequestAborted();

  const researchValidationError = resolveResearchDispatchValidationError(plan, policy);
  if (researchValidationError) {
    sendGptAccessResult(res, {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: researchValidationError.message,
        },
      },
    });
    return;
  }

  const storylineValidationError =
    resolveBackstageStorylineDispatchValidationError(plan, policy);
  if (storylineValidationError) {
    sendGptAccessResult(res, {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: storylineValidationError.message,
        },
      },
    });
    return;
  }

  if (body.dryRun) {
    res.json({
      ok: true,
      dryRun: true,
      plan,
      policy: toDispatchPolicyResponse(policy)
    });
    return;
  }

  if (!policy.allowed) {
    sendDispatchPolicyBlock(res, plan, policy);
    return;
  }

  if (policy.requiresConfirmation) {
    const confirmationFingerprintBody = {
      protocol: 'gpt-access-dispatch-confirmation-v1',
      request: req.body,
      execution: {
        action: plan.action,
        payload: plan.payload,
        registryAction: policy.registryAction
          ? {
              action: policy.registryAction.action,
              risk: policy.registryAction.risk,
              runner: policy.registryAction.runner
            }
          : null
      }
    };
    let confirmedExecution: Promise<void> | null = null;
    confirmGate(req, res, () => {
      const confirmedPolicy: DispatchPolicyDecision = {
        ...policy,
        status: 'allowed',
        requiresConfirmation: false,
        shouldExecute: true,
        reason: 'confirmation_satisfied'
      };
      confirmedExecution = executeDispatchRun(req, res, plan, confirmedPolicy).catch((error) => {
        req.logger?.error?.('gpt_access.dispatch.failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        if (!res.headersSent) {
          sendGptAccessInternalError(res, 'Dispatch execution failed.');
        }
      });
    }, {
      challengeBinding: buildGptAccessConfirmationBinding(req),
      requestFingerprintBody: confirmationFingerprintBody,
      requireChallengeToken: true
    });
    if (confirmedExecution) {
      await confirmedExecution;
    }
    return;
  }

  await executeDispatchRun(req, res, plan, policy);
}

const runGptAccessDispatch = asyncHandler(async (req, res) => {
  const abortScope = createClientDisconnectAbortScope(
    req,
    res,
    'GPT Access dispatch client disconnected',
  );
  try {
    await abortScope.run(() => executeGptAccessDispatchRequest(req, res));
  } finally {
    abortScope.cleanup();
  }
});

// Keep the leaf router safe when it is mounted without the production app.
// Both narrow middleware functions are idempotent at the request boundary.
router.use(
  '/gpt-access/gaming/sources',
  gamingSourceHttpBoundary,
  gamingSourceBodyParser
);
router.use('/gpt-access', securityHeaders);
router.use(
  [
    '/gpt-access/workers/status',
    '/gpt-access/worker-helper/health',
    '/gpt-access/jobs/create',
    '/gpt-access/jobs/result',
  ],
  noStoreResponse
);
router.use('/gpt-access/local-agent', localAgentProtocolRouter);
router.use('/gpt-access', (req, res, next) => {
  if (isGamingSourceHttpBoundaryApplied(req)) {
    next();
    return;
  }
  gptAccessRateLimit(req, res, next);
});

router.get('/gpt-access/openapi.json', (req, res) => {
  res.set('cache-control', 'no-store, max-age=0');
  res.json(buildGptAccessOpenApiDocument({
    serverUrl: resolveGptAccessOpenApiServerUrl(req)
  }));
});

router.use('/gpt-access', (req, res, next) => {
  if (isGamingSourceHttpBoundaryApplied(req)) {
    next();
    return;
  }
  gptAccessAuthMiddleware(req, res, next);
});

router.get(
  '/gpt-access/capabilities/v1',
  requireGptAccessScope('capabilities.read'),
  requireGptAccessModuleRegistry,
  listGptAccessCapabilities
);

router.get(
  '/gpt-access/capabilities/v1/:id',
  requireGptAccessScope('capabilities.read'),
  requireGptAccessModuleRegistry,
  getGptAccessCapability
);

router.post(
  '/gpt-access/capabilities/v1/:id/run',
  requireGptAccessScope('capabilities.run'),
  requireGptAccessModuleRegistry,
  mapCapabilityRunConfirmationToken,
  validateCapabilityIdempotencyKey,
  preflightResearchCapabilityRun,
  preflightBackstageStorylineCapabilityRun,
  confirmCapabilityRunWhenRequired,
  runGptAccessCapability
);

router.get(
  '/gpt-access/modules',
  requireGptAccessScope('capabilities.read'),
  requireGptAccessModuleRegistry,
  listGptAccessCapabilities
);

router.get(
  '/gpt-access/modules/:id',
  requireGptAccessScope('capabilities.read'),
  requireGptAccessModuleRegistry,
  getGptAccessCapability
);

router.get('/gpt-access/health', requireGptAccessScope('diagnostics.read'), (_req, res) => {
  res.json(buildGptAccessHealthPayload());
});

router.get(
  '/gpt-access/status',
  requireGptAccessScope('runtime.read'),
  asyncHandler(async (req, res) => {
    try {
      await writePublicHealthResponse(req, res);
    } catch {
      sendGptAccessUnavailable(
        res,
        'GPT_ACCESS_RUNTIME_UNAVAILABLE',
        'Runtime status is unavailable.'
      );
    }
  })
);

router.get(
  '/gpt-access/workers/status',
  requireGptAccessScope('workers.read'),
  asyncHandler(async (_req, res) => {
    try {
      res.json(sanitizeGptAccessPayload(await getWorkerControlStatus()));
    } catch {
      sendGptAccessUnavailable(
        res,
        'GPT_ACCESS_WORKER_UNAVAILABLE',
        'Worker status is unavailable.'
      );
    }
  })
);

router.get(
  '/gpt-access/worker-helper/health',
  requireGptAccessScope('workers.read'),
  asyncHandler(async (_req, res) => {
    try {
      res.json(sanitizeGptAccessPayload(await getWorkerControlHealth()));
    } catch {
      sendGptAccessUnavailable(
        res,
        'GPT_ACCESS_WORKER_UNAVAILABLE',
        'Worker helper health is unavailable.'
      );
    }
  })
);

router.get(
  '/gpt-access/queue/inspect',
  requireGptAccessScope('queue.read'),
  asyncHandler(async (_req, res) => {
    sendGptAccessResult(res, await getGptAccessQueueInspection());
  })
);

router.get(
  '/gpt-access/self-heal/status',
  requireGptAccessScope('mcp.approved_readonly'),
  asyncHandler(async (_req, res) => {
    sendGptAccessResult(res, await getGptAccessSelfHealStatus());
  })
);

router.post(
  '/gpt-access/jobs/create',
  requireGptAccessScope('jobs.create'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await createGptAccessAiJob(req.body, {
        actorKey: getRequestAuthenticatedActorKey(req),
        requestId: req.requestId,
        traceId: req.traceId,
        idempotencyKey: req.header('idempotency-key') ?? null,
        logger: req.logger
      })
    );
  })
);

router.post(
  '/gpt-access/jobs/result',
  requireGptAccessScope('jobs.result'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await getGptAccessJobResult(req.body, {
        actorKey: getRequestAuthenticatedActorKey(req),
        principalId: readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_PRINCIPAL_ID'),
        workspaceId: readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_WORKSPACE_ID'),
        requestId: req.requestId,
        traceId: req.traceId,
        logger: req.logger
      })
    );
  })
);

router.post(
  '/gpt-access/jobs/timeline',
  requireGptAccessScope('diagnostics.read'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await queryJobEventTimeline(req.body, {
        principalId: readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_PRINCIPAL_ID'),
        workspaceId: readConfiguredGptAccessContextId('ARCANOS_GPT_ACCESS_WORKSPACE_ID')
      })
    );
  })
);

router.post(
  '/gpt-access/gaming/sources/ingestions',
  requireGamingSourceAccessAuthentication,
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await createGamingSourceIngestion(req.body, {
        actorKey: getRequestAuthenticatedActorKey(req),
        requestId: req.requestId,
        traceId: req.traceId,
        idempotencyKey: req.header('idempotency-key') ?? null,
        logger: req.logger
      })
    );
  })
);

router.post(
  '/gpt-access/gaming/sources/refreshes',
  requireGamingSourceAccessAuthentication,
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await refreshGamingSources(req.body, {
        actorKey: getRequestAuthenticatedActorKey(req),
        requestId: req.requestId,
        traceId: req.traceId,
        idempotencyKey: req.header('idempotency-key') ?? null,
        logger: req.logger
      })
    );
  })
);

router.get(
  '/gpt-access/gaming/sources/ingestions/:ingestionId',
  requireGamingSourceAccessAuthentication,
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await getGamingSourceIngestionStatus(req.params.ingestionId, {
        actorKey: getRequestAuthenticatedActorKey(req),
        requestId: req.requestId,
        traceId: req.traceId,
        logger: req.logger
      })
    );
  })
);

router.post(
  '/gpt-access/diagnostics/deep',
  requireGptAccessScope('diagnostics.read'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await runDeepDiagnostics(req.body));
  })
);

router.post(
  '/gpt-access/db/explain',
  requireGptAccessScope('db.explain_approved'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await explainApprovedQuery(req.body));
  })
);

router.post(
  '/gpt-access/logs/query',
  requireGptAccessScope('logs.read_sanitized'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await queryBackendLogs(req.body));
  })
);

router.post(
  '/gpt-access/mcp',
  requireGptAccessScope('mcp.approved_readonly'),
  asyncHandler(async (req, res) => {
    const abortScope = createClientDisconnectAbortScope(
      req,
      res,
      'GPT Access MCP client disconnected',
    );
    try {
      const result = await abortScope.run(() => runGptAccessMcpTool(req.body));
      sendGptAccessResult(res, result);
    } finally {
      abortScope.cleanup();
    }
  })
);

router.post(
  '/gpt-access/dispatch/run',
  requireGptAccessModuleRegistry,
  mapDispatchRunConfirmationToken,
  validateCapabilityIdempotencyKey,
  runGptAccessDispatch
);

router.use('/gpt-access', (req, res) => {
  sendGptAccessResult(res, {
    statusCode: 404,
    payload: {
      ok: false,
      error: {
        code: 'GPT_ACCESS_ROUTE_NOT_FOUND',
        message: `GPT access route not found: ${req.method} ${req.path}`
      }
    }
  });
});

export default router;
