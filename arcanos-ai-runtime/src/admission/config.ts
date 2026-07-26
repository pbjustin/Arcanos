import { WATCHDOG_LIMIT_MS } from "@arcanos/runtime";

export const AI_RUNTIME_ADMISSION_MAX_OUTSTANDING_ENV_NAME =
  "AI_RUNTIME_ADMISSION_MAX_OUTSTANDING";
export const AI_RUNTIME_ADMISSION_RATE_MAX_ENV_NAME =
  "AI_RUNTIME_ADMISSION_RATE_MAX";
export const AI_RUNTIME_ADMISSION_RATE_WINDOW_MS_ENV_NAME =
  "AI_RUNTIME_ADMISSION_RATE_WINDOW_MS";
export const AI_RUNTIME_ADMISSION_PENDING_GRACE_MS_ENV_NAME =
  "AI_RUNTIME_ADMISSION_PENDING_GRACE_MS";
export const AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS_ENV_NAME =
  "AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS";
export const AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS_ENV_NAME =
  "AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS";
export const AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE_ENV_NAME =
  "AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE";
export const AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS_ENV_NAME =
  "AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS";

export interface RuntimeAdmissionConfig {
  maxOutstanding: number;
  rateMax: number;
  rateWindowMs: number;
  pendingGraceMs: number;
  missingConfirmMs: number;
  reconcileIntervalMs: number;
  reconcileBatchSize: number;
  claimGraceMs: number;
}

const INTEGER_PATTERN = /^[1-9][0-9]*$/u;

function parseRequiredInteger(
  raw: string | undefined,
  maximum: number
): number | null {
  if (
    typeof raw !== "string" ||
    raw !== raw.trim() ||
    !INTEGER_PATTERN.test(raw)
  ) {
    return null;
  }

  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum
    ? value
    : null;
}

export function resolveRuntimeAdmissionConfig(
  environment: NodeJS.ProcessEnv
): RuntimeAdmissionConfig | null {
  const maxOutstanding = parseRequiredInteger(
    environment[AI_RUNTIME_ADMISSION_MAX_OUTSTANDING_ENV_NAME],
    100000
  );
  const rateMax = parseRequiredInteger(
    environment[AI_RUNTIME_ADMISSION_RATE_MAX_ENV_NAME],
    100000
  );
  const rateWindowMs = parseRequiredInteger(
    environment[AI_RUNTIME_ADMISSION_RATE_WINDOW_MS_ENV_NAME],
    3600000
  );
  const pendingGraceMs = parseRequiredInteger(
    environment[AI_RUNTIME_ADMISSION_PENDING_GRACE_MS_ENV_NAME],
    3600000
  );
  const missingConfirmMs = parseRequiredInteger(
    environment[AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS_ENV_NAME],
    3600000
  );
  const reconcileIntervalMs = parseRequiredInteger(
    environment[
      AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS_ENV_NAME
    ],
    600000
  );
  const reconcileBatchSize = parseRequiredInteger(
    environment[
      AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE_ENV_NAME
    ],
    1000
  );
  const claimGraceMs = parseRequiredInteger(
    environment[AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS_ENV_NAME],
    3600000
  );

  if (
    maxOutstanding === null ||
    rateMax === null ||
    rateWindowMs === null ||
    rateWindowMs < 1000 ||
    pendingGraceMs === null ||
    missingConfirmMs === null ||
    reconcileIntervalMs === null ||
    reconcileBatchSize === null ||
    claimGraceMs === null ||
    reconcileIntervalMs < 1000 ||
    pendingGraceMs < reconcileIntervalMs ||
    missingConfirmMs < reconcileIntervalMs ||
    claimGraceMs < WATCHDOG_LIMIT_MS + reconcileIntervalMs
  ) {
    return null;
  }

  return Object.freeze({
    maxOutstanding,
    rateMax,
    rateWindowMs,
    pendingGraceMs,
    missingConfirmMs,
    reconcileIntervalMs,
    reconcileBatchSize,
    claimGraceMs
  });
}
