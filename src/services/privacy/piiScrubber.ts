/**
 * PII Scrubber
 *
 * Applies conservative redaction to reduce privacy risk in telemetry and evidence packs.
 * This is NOT a perfect PII detector; it's a pragmatic enterprise baseline.
 *
 * For deeper redaction, we reuse the existing security compliance redactor which also
 * scrubs credentials, paths, and environment details.
 */
import { applySecurityCompliance } from "@services/securityCompliance.js";

export interface ScrubOptions {
  enabled?: boolean;
}

export async function scrubForStorage(input: unknown, opts: ScrubOptions = {}): Promise<unknown> {
  //audit Assumption: undefined/null payloads are valid for optional evidence fields; risk: scrubber crash on `.replace`; invariant: scrubber must be total for unknown input; handling: passthrough for nullish values.
  if (input === undefined || input === null) return input;
  if (opts.enabled === false) return input;

  // Stringify and scrub, then parse back (best-effort) to keep structure.
  const raw = typeof input === 'string' ? input : JSON.stringify(input);

  // Simple PII patterns
  const redacted = raw
    // emails
    .replace(/([\w.+-]+)@([\w-]+\.[\w.-]+)/g, '[REDACTED_EMAIL]')
    // phone numbers (very rough)
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]')
    // US SSN
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]');

  // Reuse security compliance redaction for credentials/paths/env vars.
  const compliance = await applySecurityCompliance(redacted);
  const cleaned = compliance.content;

  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
}
