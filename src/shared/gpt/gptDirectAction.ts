export const ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG =
  '__arcanosSuppressTimeoutFallback' as const;

export function normalizeBooleanFlagValue(value: unknown): boolean {
  if (value === true) {
    return true;
  }

  if (value === false || value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }

  return false;
}
