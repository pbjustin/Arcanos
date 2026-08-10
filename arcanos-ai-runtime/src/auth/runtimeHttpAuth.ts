import { createHash, timingSafeEqual } from "node:crypto";
import type {
  NextFunction,
  Request,
  RequestHandler,
  Response
} from "express";

export const AI_RUNTIME_ACCESS_TOKEN_ENV_NAME =
  "ARCANOS_AI_RUNTIME_ACCESS_TOKEN";
export const AI_RUNTIME_PRINCIPAL_ID_ENV_NAME =
  "ARCANOS_AI_RUNTIME_PRINCIPAL_ID";
export const AI_RUNTIME_SCOPES_ENV_NAME = "ARCANOS_AI_RUNTIME_SCOPES";

export const AI_RUNTIME_ENQUEUE_SCOPE = "runtime:enqueue";
export const AI_RUNTIME_READ_SCOPE = "runtime:read";
export const AI_RUNTIME_LEGACY_ANONYMOUS_PRINCIPAL_ID = "anonymous";

// Keep this separately runnable workspace independent of root compiled output.
// A root drift test compares these peers with the canonical application
// credential registry.
export const AI_RUNTIME_PURPOSE_BOUND_PEER_ENV_NAMES = Object.freeze([
  "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN",
  "ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN",
  "ARCANOS_CORE_ADVISORY_ACCESS_TOKEN",
  "ARCANOS_GPT_ACCESS_TOKEN",
  "ARCANOS_GAMING_SOURCE_ACCESS_TOKEN",
  "ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN",
  "ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN",
  "ARCANOS_AUTOMATION_SECRET",
  "ARCANOS_CLI_BRIDGE_TOKEN",
  "ARCANOS_DAEMON_ACCESS_TOKEN",
  "ARCANOS_DEBUG_CMD_TOKEN",
  "ARCANOS_JOB_READ_CAPABILITY_SECRET",
  "ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET",
  "ARCANOS_MEMORY_ACCESS_TOKEN",
  "ARCANOS_WORKER_HELPER_TOKEN",
  "ACTION_PLAN_REQUEST_TOKEN",
  "ACTION_PLAN_OPERATOR_TOKEN",
  "ACTION_PLAN_EXECUTOR_TOKEN",
  "GPT_DAG_BRIDGE_BEARER_TOKEN",
  "METRICS_AUTH_TOKEN",
  "MCP_BEARER_TOKEN",
  "OPENAI_ACTION_SHARED_SECRET",
  "ROOT_OVERRIDE_TOKEN",
  "ARCANOS_ADMIN_TOKEN",
  "DEBUG_WATCHDOG_KEY",
  "DEBUG_SERVER_TOKEN"
]);

const MIN_ACCESS_TOKEN_LENGTH = 32;
const MAX_ACCESS_TOKEN_LENGTH = 4096;
const MAX_CONFIGURED_SCOPES_LENGTH = 512;
const MAX_CONFIGURED_SCOPES = 8;
const PRINCIPAL_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const BEARER_TOKEN_PATTERN = /^[\x21-\x7E]+$/u;
const PLACEHOLDER_CREDENTIAL_PATTERN =
  /^(?:<[^>]+>|(?:change[-_]?me|example|placeholder)(?:[-_].*)?|replace[-_]?with(?:[-_].*)?)$/iu;
const ALLOWED_SCOPES = new Set([
  AI_RUNTIME_ENQUEUE_SCOPE,
  AI_RUNTIME_READ_SCOPE
]);

export type AiRuntimeHttpScope =
  | typeof AI_RUNTIME_ENQUEUE_SCOPE
  | typeof AI_RUNTIME_READ_SCOPE;

export interface AiRuntimeHttpPrincipal {
  audience: "ai-runtime-http";
  principalId: string;
  scopes: readonly AiRuntimeHttpScope[];
}

interface ConfiguredAiRuntimePrincipal extends AiRuntimeHttpPrincipal {
  credential: string;
}

export type AiRuntimeHttpAuthenticationResult =
  | {
      ok: true;
      principal: AiRuntimeHttpPrincipal;
    }
  | {
      ok: false;
      reason: "configuration_unavailable" | "missing_auth" | "invalid_auth";
    };

const principalByRequest = new WeakMap<Request, AiRuntimeHttpPrincipal>();

function readConfiguredCredential(value: string | undefined): string | null {
  if (
    typeof value !== "string" ||
    value.length < MIN_ACCESS_TOKEN_LENGTH ||
    value.length > MAX_ACCESS_TOKEN_LENGTH ||
    value !== value.trim() ||
    !BEARER_TOKEN_PATTERN.test(value) ||
    PLACEHOLDER_CREDENTIAL_PATTERN.test(value)
  ) {
    return null;
  }

  return value;
}

export function readConfiguredAiRuntimePrincipalId(
  value: string | undefined
): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    value === AI_RUNTIME_LEGACY_ANONYMOUS_PRINCIPAL_ID ||
    !PRINCIPAL_ID_PATTERN.test(value)
  ) {
    return null;
  }

  return value;
}

function readConfiguredScopes(
  value: string | undefined
): AiRuntimeHttpScope[] | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CONFIGURED_SCOPES_LENGTH
  ) {
    return null;
  }

  const rawScopes = value.split(",");
  if (
    rawScopes.length === 0 ||
    rawScopes.length > MAX_CONFIGURED_SCOPES
  ) {
    return null;
  }

  const scopes: AiRuntimeHttpScope[] = [];
  for (const rawScope of rawScopes) {
    const scope = rawScope.trim();
    if (!ALLOWED_SCOPES.has(scope)) {
      return null;
    }
    scopes.push(scope as AiRuntimeHttpScope);
  }

  return [...new Set(scopes)];
}

function resolveConfiguredPrincipal(
  environment: NodeJS.ProcessEnv
): ConfiguredAiRuntimePrincipal | null {
  const credential = readConfiguredCredential(
    environment[AI_RUNTIME_ACCESS_TOKEN_ENV_NAME]
  );
  const principalId = readConfiguredAiRuntimePrincipalId(
    environment[AI_RUNTIME_PRINCIPAL_ID_ENV_NAME]
  );
  const scopes = readConfiguredScopes(
    environment[AI_RUNTIME_SCOPES_ENV_NAME]
  );
  const credentialCollides = credential
    ? AI_RUNTIME_PURPOSE_BOUND_PEER_ENV_NAMES.some((environmentName) => {
        const rawCandidate = environment[environmentName];
        if (typeof rawCandidate !== "string") {
          return false;
        }

        const candidate = rawCandidate.trim();
        return (
          candidate.length > 0 &&
          candidate.length <= MAX_ACCESS_TOKEN_LENGTH &&
          timingSafeEqualCredential(credential, candidate)
        );
      })
    : false;

  if (!credential || !principalId || !scopes || credentialCollides) {
    return null;
  }

  return {
    audience: "ai-runtime-http",
    principalId,
    scopes,
    credential
  };
}

function countRawAuthorizationHeaders(req: Request): number {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let count = 0;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const headerName = rawHeaders[index];
    if (
      typeof headerName === "string" &&
      headerName.toLowerCase() === "authorization"
    ) {
      count += 1;
    }
  }

  return count;
}

export function extractAiRuntimeBearerToken(req: Request): string | null {
  if (countRawAuthorizationHeaders(req) !== 1) {
    return null;
  }

  const authorization = req.header("authorization");
  if (
    typeof authorization !== "string" ||
    authorization.length > MAX_ACCESS_TOKEN_LENGTH + 7
  ) {
    return null;
  }

  const match = /^Bearer ([\x21-\x7E]+)$/u.exec(authorization);
  const credential = match?.[1];
  if (
    !credential ||
    credential.length < MIN_ACCESS_TOKEN_LENGTH ||
    credential.length > MAX_ACCESS_TOKEN_LENGTH
  ) {
    return null;
  }

  return credential;
}

function timingSafeEqualCredential(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function authenticateAiRuntimeHttpRequest(
  req: Request,
  environment: NodeJS.ProcessEnv = process.env
): AiRuntimeHttpAuthenticationResult {
  const configuredPrincipal = resolveConfiguredPrincipal(environment);
  if (!configuredPrincipal) {
    return {
      ok: false,
      reason: "configuration_unavailable"
    };
  }

  const credential = extractAiRuntimeBearerToken(req);
  if (!credential) {
    return {
      ok: false,
      reason: req.header("authorization") ? "invalid_auth" : "missing_auth"
    };
  }

  if (!timingSafeEqualCredential(credential, configuredPrincipal.credential)) {
    return {
      ok: false,
      reason: "invalid_auth"
    };
  }

  return {
    ok: true,
    principal: {
      audience: configuredPrincipal.audience,
      principalId: configuredPrincipal.principalId,
      scopes: [...configuredPrincipal.scopes]
    }
  };
}

function sendAuthenticationError(
  res: Response,
  statusCode: 401 | 403 | 503,
  code: string,
  message: string
): void {
  res.setHeader("Cache-Control", "no-store");
  if (statusCode === 401) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="ai-runtime"');
  }
  res.status(statusCode).json({
    error: {
      code,
      message
    }
  });
}

export function createAiRuntimeAuthenticationMiddleware(
  environment: NodeJS.ProcessEnv = process.env
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = authenticateAiRuntimeHttpRequest(req, environment);
    if (!result.ok) {
      const configurationUnavailable =
        result.reason === "configuration_unavailable";
      sendAuthenticationError(
        res,
        configurationUnavailable ? 503 : 401,
        configurationUnavailable
          ? "AI_RUNTIME_AUTH_UNAVAILABLE"
          : "AI_RUNTIME_AUTH_REQUIRED",
        configurationUnavailable
          ? "AI runtime authentication is unavailable."
          : "AI runtime bearer authentication is required."
      );
      return;
    }

    principalByRequest.set(req, result.principal);
    next();
  };
}

export function getAiRuntimeHttpPrincipal(
  req: Request
): AiRuntimeHttpPrincipal | null {
  return principalByRequest.get(req) ?? null;
}

export function requireAiRuntimeScope(
  requiredScope: AiRuntimeHttpScope
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = getAiRuntimeHttpPrincipal(req);
    if (!principal?.scopes.includes(requiredScope)) {
      sendAuthenticationError(
        res,
        403,
        "AI_RUNTIME_SCOPE_DENIED",
        "AI runtime operation is not permitted."
      );
      return;
    }

    next();
  };
}
