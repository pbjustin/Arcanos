/**
 * Purpose: Narrow unknown values to plain object records for runtime validation.
 * Inputs/Outputs: Unknown value in; boolean type-guard result out.
 * Edge cases: Rejects null and arrays because downstream normalizers expect key/value records only.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  //audit Assumption: record-like payloads must be non-null objects and not arrays; failure risk: arrays treated as keyed maps during normalization; expected invariant: only plain object-like values pass; handling strategy: explicit runtime shape check.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
