export interface DiagnosticRequestLike {
  mode?: unknown;
  action?: unknown;
  prompt?: unknown;
  message?: unknown;
  userInput?: unknown;
  content?: unknown;
  text?: unknown;
  query?: unknown;
}

function normalizeSignal(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

/**
 * Extract the primary text input from an ask-like request payload.
 * Inputs: request body carrying one of the supported text aliases.
 * Outputs: normalized text string or `null` when no supported text field is present.
 * Edge cases: field precedence is fixed so all diagnostic checks stay deterministic.
 */
export function extractDiagnosticTextInput(body: DiagnosticRequestLike | null | undefined): string | null {
  const candidates = [body?.prompt, body?.message, body?.userInput, body?.content, body?.text, body?.query];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Detect explicit lightweight diagnostic probes that should bypass normal AI routing.
 * Inputs: request body plus the already-extracted primary text input when available.
 * Outputs: boolean flag indicating whether the request should take the deterministic diagnostic shortcut.
 * Edge cases: missing text input is allowed when callers send an explicit `action: "ping"` or `mode: "diagnostic"` probe.
 */
export function isDiagnosticRequest(
  body: DiagnosticRequestLike | null | undefined,
  textInput?: string | null
): boolean {
  const normalizedMode = normalizeSignal(body?.mode);
  const normalizedAction = normalizeSignal(body?.action);
  const normalizedTextInput = normalizeSignal(textInput);

  return normalizedMode === 'diagnostic'
    || normalizedAction === 'ping'
    || normalizedTextInput === 'ping';
}
