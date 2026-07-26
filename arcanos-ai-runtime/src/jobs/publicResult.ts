const MAX_PUBLIC_OUTPUT_TEXT_BYTES = 128 * 1024;
const OUTPUT_TRUNCATION_MARKER = "\n[truncated]";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const TIMEOUT_STAGES = new Set([
  "reasoning",
  "validation",
  "second_pass"
]);
const MAX_PROVIDER_OUTPUT_ITEMS_TO_INSPECT = 128;
const MAX_PROVIDER_CONTENT_ITEMS_TO_INSPECT = 128;

export const AI_RUNTIME_PUBLIC_RESULT_LIMITS = Object.freeze({
  maxOutputTextBytes: MAX_PUBLIC_OUTPUT_TEXT_BYTES
});

export interface PublicTextJobResult {
  output_text: string;
  truncated?: true;
}

export interface PublicTimeoutJobResult {
  status: "timeout_prevented";
  category: "runtime_budget_exhausted";
  stage: "reasoning" | "validation" | "second_pass";
  partial: boolean;
  confidence: number | null;
  elapsed_ms: number;
  remaining_budget_ms: number;
  watchdog_limit_ms: number;
  trace_id: string;
}

export type PublicRuntimeJobResult =
  | PublicTextJobResult
  | PublicTimeoutJobResult;

export type PublicResultProjection =
  | { ok: true; result: PublicRuntimeJobResult }
  | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) {
    return value;
  }

  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");
  const contentByteLimit = Math.max(0, maxBytes - markerBytes - 3);
  let truncated = encoded.subarray(0, contentByteLimit).toString("utf8");
  while (
    truncated.length > 0 &&
    Buffer.byteLength(truncated, "utf8") > contentByteLimit
  ) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}${OUTPUT_TRUNCATION_MARKER}`;
}

function projectTimeoutEnvelope(
  value: Record<string, unknown>
): PublicTimeoutJobResult | null {
  if (
    value.status !== "timeout_prevented" ||
    value.category !== "runtime_budget_exhausted" ||
    typeof value.stage !== "string" ||
    !TIMEOUT_STAGES.has(value.stage) ||
    typeof value.partial !== "boolean" ||
    !(
      value.confidence === null ||
      (
        isFiniteNumber(value.confidence) &&
        value.confidence >= 0 &&
        value.confidence <= 1
      )
    ) ||
    !isFiniteNumber(value.elapsed_ms) ||
    !isFiniteNumber(value.remaining_budget_ms) ||
    !isFiniteNumber(value.watchdog_limit_ms) ||
    typeof value.trace_id !== "string" ||
    !UUID_V4_PATTERN.test(value.trace_id)
  ) {
    return null;
  }

  return {
    status: "timeout_prevented",
    category: "runtime_budget_exhausted",
    stage: value.stage as PublicTimeoutJobResult["stage"],
    partial: value.partial,
    confidence: value.confidence,
    elapsed_ms: value.elapsed_ms,
    remaining_budget_ms: value.remaining_budget_ms,
    watchdog_limit_ms: value.watchdog_limit_ms,
    trace_id: value.trace_id
  };
}

function containsProviderRefusal(
  value: Record<string, unknown>
): boolean {
  if (
    typeof value.refusal === "string" &&
    value.refusal.trim().length > 0
  ) {
    return true;
  }
  if (value.refusal !== undefined && value.refusal !== null) {
    return true;
  }

  if (value.output === undefined) {
    return false;
  }
  if (
    !Array.isArray(value.output) ||
    value.output.length > MAX_PROVIDER_OUTPUT_ITEMS_TO_INSPECT
  ) {
    return true;
  }

  for (const outputItem of value.output) {
    if (!isRecord(outputItem)) {
      continue;
    }

    if (outputItem.content === undefined) {
      continue;
    }
    if (
      !Array.isArray(outputItem.content) ||
      outputItem.content.length >
        MAX_PROVIDER_CONTENT_ITEMS_TO_INSPECT
    ) {
      return true;
    }

    for (const contentItem of outputItem.content) {
      if (!isRecord(contentItem)) {
        continue;
      }
      if (
        contentItem.type === "refusal" ||
        (
          typeof contentItem.refusal === "string" &&
          contentItem.refusal.trim().length > 0
        ) ||
        (
          contentItem.refusal !== undefined &&
          contentItem.refusal !== null
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

export function projectPublicJobResult(
  value: unknown
): PublicResultProjection {
  if (!isRecord(value)) {
    return { ok: false };
  }

  const timeoutEnvelope = projectTimeoutEnvelope(value);
  if (timeoutEnvelope) {
    return { ok: true, result: timeoutEnvelope };
  }

  if (
    (
      value.status !== undefined &&
      value.status !== "completed"
    ) ||
    (value.error !== undefined && value.error !== null) ||
    (
      value.incomplete_details !== undefined &&
      value.incomplete_details !== null
    ) ||
    containsProviderRefusal(value)
  ) {
    return { ok: false };
  }

  if (typeof value.output_text !== "string") {
    return { ok: false };
  }

  const outputText = truncateUtf8(
    value.output_text,
    MAX_PUBLIC_OUTPUT_TEXT_BYTES
  );
  const result: PublicTextJobResult = { output_text: outputText };
  if (outputText !== value.output_text) {
    result.truncated = true;
  }
  return { ok: true, result };
}
