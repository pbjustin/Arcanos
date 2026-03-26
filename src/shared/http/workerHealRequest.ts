type WorkerHealMode = 'plan' | 'execute';

export interface WorkerHealRequest {
  force?: boolean;
  execute?: boolean;
  mode?: WorkerHealMode;
  planOnlyRequested: boolean;
  requestedExecution: boolean;
}

type WorkerHealParseResult =
  | {
      success: true;
      data: WorkerHealRequest;
    }
  | {
      success: false;
      issues: string[];
    };

function readRequestValue(candidate: unknown, field: string): unknown {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }

  const value = (candidate as Record<string, unknown>)[field];
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanField(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return undefined;
}

function parseModeField(value: unknown): WorkerHealMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'plan' || normalized === 'execute' ? normalized : undefined;
}

function wasFieldProvided(value: unknown): boolean {
  return value !== undefined && value !== null && (!(typeof value === 'string') || value.trim().length > 0);
}

/**
 * Resolve one worker-heal request from body and query inputs.
 * Purpose: allow both JSON and query-string invocation for operator-safe plan/execute flows.
 * Inputs/outputs: accepts unknown body/query payloads and returns either normalized flags or validation issues.
 * Edge case behavior: invalid boolean/mode strings return a 400-safe issue list instead of silently coercing.
 */
export function parseWorkerHealRequest(body: unknown, query: unknown): WorkerHealParseResult {
  const rawMode = readRequestValue(body, 'mode') ?? readRequestValue(query, 'mode');
  const rawExecute = readRequestValue(body, 'execute') ?? readRequestValue(query, 'execute');
  const rawForce = readRequestValue(body, 'force') ?? readRequestValue(query, 'force');
  const rawDryRun = readRequestValue(body, 'dryRun') ?? readRequestValue(query, 'dryRun');

  const mode = parseModeField(rawMode);
  const execute = parseBooleanField(rawExecute);
  const force = parseBooleanField(rawForce);
  const dryRun = parseBooleanField(rawDryRun);
  const issues: string[] = [];

  if (wasFieldProvided(rawMode) && !mode) {
    issues.push('mode must be "plan" or "execute".');
  }

  if (wasFieldProvided(rawExecute) && execute === undefined) {
    issues.push('execute must be a boolean.');
  }

  if (wasFieldProvided(rawForce) && force === undefined) {
    issues.push('force must be a boolean.');
  }

  if (wasFieldProvided(rawDryRun) && dryRun === undefined) {
    issues.push('dryRun must be a boolean.');
  }

  const planOnlyRequested = mode === 'plan' || execute === false || dryRun === true;
  const requestedExecution = mode === 'execute' || execute === true;

  if (mode === 'plan' && execute === true) {
    issues.push('mode=plan conflicts with execute=true.');
  }

  if (mode === 'execute' && execute === false) {
    issues.push('mode=execute conflicts with execute=false.');
  }

  if (dryRun === true && requestedExecution) {
    issues.push('dryRun=true conflicts with execute=true.');
  }

  if (issues.length > 0) {
    return {
      success: false,
      issues
    };
  }

  return {
    success: true,
    data: {
      ...(force !== undefined ? { force } : {}),
      ...(requestedExecution ? { execute: true, mode: 'execute' as const } : {}),
      ...(planOnlyRequested && !requestedExecution ? { execute: false, mode: 'plan' as const } : {}),
      planOnlyRequested,
      requestedExecution
    }
  };
}
