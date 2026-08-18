/**
 * Force stateless provider execution whenever caller-owned sensitive-context
 * diagnostics are redacted. Undefined preserves the ordinary configured
 * provider-retention policy for non-sensitive calls.
 */
export function resolveSensitiveProviderStore(
  redactErrorDetails: boolean | undefined
): false | undefined {
  return redactErrorDetails ? false : undefined;
}
