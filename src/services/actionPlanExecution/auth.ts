import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';

export const ACTION_PLAN_AUTH_ERROR = {
  code: 'ACTION_PLAN_EXECUTION_AUTH_REQUIRED',
  message: 'ActionPlan execution authentication is required.',
} as const;

export const ACTION_PLAN_FORBIDDEN_ERROR = {
  code: 'ACTION_PLAN_EXECUTION_FORBIDDEN',
  message: 'ActionPlan execution operation is not permitted.',
} as const;

export const LOCAL_AGENT_EXECUTOR_AUTH_ERROR = {
  code: 'LOCAL_AGENT_EXECUTOR_AUTH_REQUIRED',
  message: 'Local-agent executor authentication is required.',
} as const;

export const LOCAL_AGENT_EXECUTOR_FORBIDDEN_ERROR = {
  code: 'LOCAL_AGENT_EXECUTOR_FORBIDDEN',
  message: 'Local-agent executor operation is not permitted.',
} as const;

const MAX_BEARER_TOKEN_LENGTH = 4096;
const MIN_CONFIGURED_TOKEN_LENGTH = 32;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_LOCAL_AGENT_PREVIOUS_CREDENTIAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export const LOCAL_AGENT_EXECUTOR_SCOPES = [
  'local-agent.heartbeat',
  'local-agent.jobs.claim',
  'local-agent.jobs.heartbeat',
  'local-agent.jobs.result',
] as const;
export type LocalAgentExecutorScope = (typeof LOCAL_AGENT_EXECUTOR_SCOPES)[number];

export type ActionPlanPrincipalRole = 'requester' | 'operator' | 'executor';

export interface ActionPlanPrincipal {
  role: ActionPlanPrincipalRole;
  principalId: string;
  executorInstanceId?: string;
  executorAgentId?: string;
}

interface ConfiguredPrincipal extends ActionPlanPrincipal {
  credential: string;
}

export interface ActionPlanAuthConfiguration {
  valid: boolean;
  principals: readonly ConfiguredPrincipal[];
}

export interface ActionPlanExecutorServerBinding {
  kind: 'python-daemon';
  principalId: string;
  instanceId: string;
  agentId: string;
}

export interface LocalAgentExecutorPrincipal {
  role: 'local-agent-executor';
  audience: 'local-agent-protocol';
  principalId: string;
  executorInstanceId: string;
  executorDeviceId: string;
  credentialVersion: 'current' | 'previous';
  scopes: readonly LocalAgentExecutorScope[];
}

export interface LocalAgentExecutorServerBinding {
  kind: 'python-daemon';
  audience: 'local-agent-protocol';
  principalId: string;
  instanceId: string;
  deviceId: string;
}

interface ConfiguredLocalAgentExecutor {
  binding: LocalAgentExecutorServerBinding;
  currentCredential: string;
  previousCredential?: {
    credential: string;
    expiresAt: number;
  };
}

const SENSITIVE_ENVIRONMENT_NAME_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION|COOKIE|DATABASE_URL|REDIS_URL)/iu;

function readBoundedValue(value: string | undefined, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value !== value.trim()) {
    return null;
  }
  return value;
}

function readPrincipalId(value: string | undefined): string | null {
  const normalized = readBoundedValue(value, 128);
  return normalized && PRINCIPAL_ID_PATTERN.test(normalized) ? normalized : null;
}

function readConfiguredToken(value: string | undefined): string | null {
  const credential = readBoundedValue(value, MAX_BEARER_TOKEN_LENGTH);
  return credential && credential.length >= MIN_CONFIGURED_TOKEN_LENGTH ? credential : null;
}

function opaqueCredentialsEqual(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqualOpaqueSecret(left, right);
}

function readIsoTimestamp(value: string | undefined): number | null {
  const normalized = readBoundedValue(value, 64);
  if (!normalized || !ISO_TIMESTAMP_PATTERN.test(normalized)) {
    return null;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readConfiguredCredentialCandidates(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): string[] {
  const credentials: string[] = [];
  for (const name of names) {
    const credential = readConfiguredToken(env[name]);
    if (credential) {
      credentials.push(credential);
    }
  }
  return credentials;
}

function conflictsWithAnyCredential(
  credential: string,
  candidates: readonly string[],
): boolean {
  return candidates.some(candidate => opaqueCredentialsEqual(credential, candidate));
}

function resolveConfiguredLocalAgentExecutor(
  env: NodeJS.ProcessEnv,
  now: number,
): ConfiguredLocalAgentExecutor | null {
  const currentCredential = readConfiguredToken(env.ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN);
  const principalId = readPrincipalId(env.ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID);
  const instanceId = readPrincipalId(env.ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID);
  const deviceId = readPrincipalId(env.ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID);
  if (!currentCredential || !principalId || !instanceId || !deviceId) {
    return null;
  }

  const previousCredentialPresent =
    typeof env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN === 'string'
    && env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN.length > 0;
  const previousExpiryPresent =
    typeof env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT === 'string'
    && env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT.length > 0;
  if (previousCredentialPresent !== previousExpiryPresent) {
    return null;
  }

  let previousCredential: ConfiguredLocalAgentExecutor['previousCredential'];
  if (previousCredentialPresent) {
    const credential = readConfiguredToken(
      env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN,
    );
    const expiresAt = readIsoTimestamp(
      env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT,
    );
    if (
      !credential
      || expiresAt === null
      || opaqueCredentialsEqual(currentCredential, credential)
      || (expiresAt > now && expiresAt - now > MAX_LOCAL_AGENT_PREVIOUS_CREDENTIAL_WINDOW_MS)
    ) {
      return null;
    }
    if (expiresAt > now) {
      previousCredential = { credential, expiresAt };
    }
  }

  const gptAccessCredential = readBoundedValue(
    env.ARCANOS_GPT_ACCESS_TOKEN,
    MAX_BEARER_TOKEN_LENGTH,
  );
  const conflictingCredentials = [
    ...readConfiguredCredentialCandidates(env, [
      'ACTION_PLAN_REQUEST_TOKEN',
      'ACTION_PLAN_OPERATOR_TOKEN',
      'ACTION_PLAN_EXECUTOR_TOKEN',
    ]),
    ...(gptAccessCredential ? [gptAccessCredential] : []),
  ];
  if (
    conflictsWithAnyCredential(currentCredential, conflictingCredentials)
    || (
      previousCredential
      && conflictsWithAnyCredential(previousCredential.credential, conflictingCredentials)
    )
  ) {
    return null;
  }

  return {
    binding: {
      kind: 'python-daemon',
      audience: 'local-agent-protocol',
      principalId,
      instanceId,
      deviceId,
    },
    currentCredential,
    ...(previousCredential ? { previousCredential } : {}),
  };
}

function pushConfiguredPrincipal(
  principals: ConfiguredPrincipal[],
  input: {
    role: ActionPlanPrincipalRole;
    credential: string | undefined;
    principalId: string | undefined;
    executorInstanceId?: string | undefined;
    executorAgentId?: string | undefined;
  },
): boolean {
  const credentialPresent = typeof input.credential === 'string' && input.credential.length > 0;
  const principalPresent = typeof input.principalId === 'string' && input.principalId.length > 0;
  const executorFieldsPresent = input.role === 'executor'
    && (Boolean(input.executorInstanceId) || Boolean(input.executorAgentId));

  if (!credentialPresent && !principalPresent && !executorFieldsPresent) {
    return true;
  }

  const credential = readConfiguredToken(input.credential);
  const principalId = readPrincipalId(input.principalId);
  if (!credential || !principalId) {
    return false;
  }

  let executorInstanceId: string | undefined;
  let executorAgentId: string | undefined;
  if (input.role === 'executor') {
    executorInstanceId = readPrincipalId(input.executorInstanceId) ?? undefined;
    executorAgentId = readPrincipalId(input.executorAgentId) ?? undefined;
    if (!executorInstanceId || !executorAgentId) {
      return false;
    }
  }

  principals.push({
    role: input.role,
    principalId,
    credential,
    ...(executorInstanceId ? { executorInstanceId } : {}),
    ...(executorAgentId ? { executorAgentId } : {}),
  });
  return true;
}

/** Resolve purpose-bound principals without ever returning credential material to a caller. */
export function resolveActionPlanAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ActionPlanAuthConfiguration {
  const principals: ConfiguredPrincipal[] = [];
  const entriesValid = [
    pushConfiguredPrincipal(principals, {
      role: 'requester',
      credential: env.ACTION_PLAN_REQUEST_TOKEN,
      principalId: env.ACTION_PLAN_REQUEST_PRINCIPAL_ID,
    }),
    pushConfiguredPrincipal(principals, {
      role: 'operator',
      credential: env.ACTION_PLAN_OPERATOR_TOKEN,
      principalId: env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID,
    }),
    pushConfiguredPrincipal(principals, {
      role: 'executor',
      credential: env.ACTION_PLAN_EXECUTOR_TOKEN,
      principalId: env.ACTION_PLAN_EXECUTOR_PRINCIPAL_ID,
      executorInstanceId: env.ACTION_PLAN_EXECUTOR_INSTANCE_ID,
      executorAgentId: env.ACTION_PLAN_EXECUTOR_AGENT_ID,
    }),
  ].every(Boolean);

  const credentials = principals.map(principal => principal.credential);
  const principalIds = principals.map(principal => principal.principalId);
  const uniqueCredentials = new Set(credentials).size === credentials.length;
  const uniquePrincipalIds = new Set(principalIds).size === principalIds.length;
  const localAgentCredentialsIsolated = credentials.every(
    credential => !conflictsWithLocalAgentExecutorCredential(credential, env),
  );

  return {
    valid:
      entriesValid
      && uniqueCredentials
      && uniquePrincipalIds
      && localAgentCredentialsIsolated,
    principals:
      entriesValid
      && uniqueCredentials
      && uniquePrincipalIds
      && localAgentCredentialsIsolated
        ? principals
        : [],
  };
}

export function resolveActionPlanExecutorServerBinding(
  env: NodeJS.ProcessEnv = process.env,
): ActionPlanExecutorServerBinding | null {
  const configuration = resolveActionPlanAuthConfiguration(env);
  const executor = configuration.principals.find(principal => principal.role === 'executor');
  if (!configuration.valid || !executor?.executorInstanceId || !executor.executorAgentId) {
    return null;
  }
  return {
    kind: 'python-daemon',
    principalId: executor.principalId,
    instanceId: executor.executorInstanceId,
    agentId: executor.executorAgentId,
  };
}

export function resolveLocalAgentExecutorServerBinding(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): LocalAgentExecutorServerBinding | null {
  return resolveConfiguredLocalAgentExecutor(env, now)?.binding ?? null;
}

export function conflictsWithLocalAgentExecutorCredential(
  candidateCredential: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  const credentials = readConfiguredCredentialCandidates(env, [
    'ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN',
  ]);
  const previousCredential = readConfiguredToken(
    env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN,
  );
  const previousExpiresAt = readIsoTimestamp(
    env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT,
  );
  if (
    previousCredential
    && previousExpiresAt !== null
    && previousExpiresAt > now
    && previousExpiresAt - now <= MAX_LOCAL_AGENT_PREVIOUS_CREDENTIAL_WINDOW_MS
  ) {
    credentials.push(previousCredential);
  }
  return conflictsWithAnyCredential(
    candidateCredential,
    credentials,
  );
}

/** Compare a candidate against configured ActionPlan credentials without exposing them. */
export function conflictsWithActionPlanCredential(
  candidateCredential: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuration = resolveActionPlanAuthConfiguration(env);
  return configuration.valid && configuration.principals.some(
    principal => timingSafeEqualOpaqueSecret(principal.credential, candidateCredential),
  );
}

/** Values are used only for exact snapshot rejection and must never be logged or serialized. */
export function readActionPlanSnapshotSensitiveValues(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (SENSITIVE_ENVIRONMENT_NAME_PATTERN.test(name) && typeof value === 'string' && value.length > 0) {
      values.add(value);
    }
  }
  return [...values];
}

function countRawAuthorizationHeaders(req: Request): number {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (typeof rawHeaders[index] === 'string' && rawHeaders[index].toLowerCase() === 'authorization') {
      count += 1;
    }
  }
  return count;
}

/** Parse exactly one `Bearer <opaque-value>` header without trimming or normalizing the secret. */
export function extractActionPlanBearerToken(req: Request): string | null {
  if (countRawAuthorizationHeaders(req) > 1) {
    return null;
  }

  const authorization = req.header('authorization');
  if (typeof authorization !== 'string' || authorization.length > MAX_BEARER_TOKEN_LENGTH + 7) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match || match[1].length === 0 || match[1].length > MAX_BEARER_TOKEN_LENGTH) {
    return null;
  }
  return match[1];
}

export function authenticateActionPlanRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): ActionPlanPrincipal | null {
  const bearerCredential = extractActionPlanBearerToken(req);
  const configuration = resolveActionPlanAuthConfiguration(env);
  if (!bearerCredential || !configuration.valid) {
    return null;
  }

  let matched: ConfiguredPrincipal | null = null;
  for (const principal of configuration.principals) {
    if (timingSafeEqualOpaqueSecret(bearerCredential, principal.credential)) {
      matched = principal;
    }
  }

  if (!matched) {
    return null;
  }

  return {
    role: matched.role,
    principalId: matched.principalId,
    ...(matched.executorInstanceId ? { executorInstanceId: matched.executorInstanceId } : {}),
    ...(matched.executorAgentId ? { executorAgentId: matched.executorAgentId } : {}),
  };
}

export function authenticateLocalAgentExecutorRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): LocalAgentExecutorPrincipal | null {
  const bearerCredential = extractActionPlanBearerToken(req);
  const configured = resolveConfiguredLocalAgentExecutor(env, now);
  if (!bearerCredential || !configured) {
    return null;
  }

  let credentialVersion: LocalAgentExecutorPrincipal['credentialVersion'] | null = null;
  if (opaqueCredentialsEqual(bearerCredential, configured.currentCredential)) {
    credentialVersion = 'current';
  } else if (
    configured.previousCredential
    && opaqueCredentialsEqual(
      bearerCredential,
      configured.previousCredential.credential,
    )
  ) {
    credentialVersion = 'previous';
  }
  if (!credentialVersion) {
    return null;
  }

  return {
    role: 'local-agent-executor',
    audience: configured.binding.audience,
    principalId: configured.binding.principalId,
    executorInstanceId: configured.binding.instanceId,
    executorDeviceId: configured.binding.deviceId,
    credentialVersion,
    scopes: [...LOCAL_AGENT_EXECUTOR_SCOPES],
  };
}

export function actionPlanAuthenticationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const principal = authenticateActionPlanRequest(req);
  if (!principal) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({
      ok: false,
      error: { code: ACTION_PLAN_AUTH_ERROR.code, message: ACTION_PLAN_AUTH_ERROR.message },
      ...(req.requestId ? { request_id: req.requestId } : {}),
      ...(req.traceId ? { trace_id: req.traceId } : {}),
    });
    return;
  }
  req.actionPlanPrincipal = principal;
  next();
}

export function localAgentExecutorAuthenticationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const principal = authenticateLocalAgentExecutorRequest(req);
  if (!principal) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({
      ok: false,
      error: {
        code: LOCAL_AGENT_EXECUTOR_AUTH_ERROR.code,
        message: LOCAL_AGENT_EXECUTOR_AUTH_ERROR.message,
      },
      ...(req.requestId ? { request_id: req.requestId } : {}),
      ...(req.traceId ? { trace_id: req.traceId } : {}),
    });
    return;
  }
  req.localAgentExecutorPrincipal = principal;
  next();
}

export function requireActionPlanRoles(...roles: readonly ActionPlanPrincipalRole[]) {
  const allowed = new Set<ActionPlanPrincipalRole>(roles);
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = req.actionPlanPrincipal;
    if (!principal || !allowed.has(principal.role)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(403).json({
        ok: false,
        error: { code: ACTION_PLAN_FORBIDDEN_ERROR.code, message: ACTION_PLAN_FORBIDDEN_ERROR.message },
        ...(req.requestId ? { request_id: req.requestId } : {}),
        ...(req.traceId ? { trace_id: req.traceId } : {}),
      });
      return;
    }
    next();
  };
}

export function requireLocalAgentExecutorScopes(
  ...scopes: readonly LocalAgentExecutorScope[]
) {
  const required = new Set<LocalAgentExecutorScope>(scopes);
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = req.localAgentExecutorPrincipal;
    const granted = new Set(principal?.scopes ?? []);
    if (
      !principal
      || principal.role !== 'local-agent-executor'
      || principal.audience !== 'local-agent-protocol'
      || [...required].some(scope => !granted.has(scope))
    ) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(403).json({
        ok: false,
        error: {
          code: LOCAL_AGENT_EXECUTOR_FORBIDDEN_ERROR.code,
          message: LOCAL_AGENT_EXECUTOR_FORBIDDEN_ERROR.message,
        },
        ...(req.requestId ? { request_id: req.requestId } : {}),
        ...(req.traceId ? { trace_id: req.traceId } : {}),
      });
      return;
    }
    next();
  };
}
