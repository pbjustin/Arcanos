/**
 * Parse an integer from an environment variable string.
 * Inputs: raw string value, fallback number.
 * Outputs: parsed integer or fallback when invalid.
 * Edge cases: undefined, empty, or non-numeric values fall back.
 */
export const parseEnvInt = (value: string | undefined, fallback: number): number => {
  //audit Assumption: undefined or empty input means "use fallback"; risk: unintended default; invariant: return a number; handling: guard and return fallback.
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  //audit Assumption: non-numeric input should not throw; risk: NaN propagation; invariant: numeric output; handling: fallback on NaN.
  return Number.isNaN(parsed) ? fallback : parsed;
};

/**
 * Parse a float from an environment variable string.
 * Inputs: raw string value, fallback number.
 * Outputs: parsed float or fallback when invalid.
 * Edge cases: undefined, empty, or non-numeric values fall back.
 */
export const parseEnvFloat = (value: string | undefined, fallback: number): number => {
  //audit Assumption: undefined or empty input means "use fallback"; risk: unintended default; invariant: return a number; handling: guard and return fallback.
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  //audit Assumption: non-numeric input should not throw; risk: NaN propagation; invariant: numeric output; handling: fallback on NaN.
  return Number.isNaN(parsed) ? fallback : parsed;
};

/**
 * Parse a boolean from an environment variable string.
 * Inputs: raw string value, fallback boolean.
 * Outputs: parsed boolean or fallback when value is unrecognized.
 * Edge cases: undefined or unexpected strings fall back.
 */
export const parseEnvBoolean = (value: string | undefined, fallback: boolean): boolean => {
  //audit Assumption: undefined means "use fallback"; risk: misconfig; invariant: boolean output; handling: guard and return fallback.
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  //audit Assumption: "false"/"0"/"off"/"no" are explicit false; risk: misread; invariant: boolean output; handling: explicit false mapping.
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  //audit Assumption: "true"/"1"/"on"/"yes" are explicit true; risk: misread; invariant: boolean output; handling: explicit true mapping.
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  //audit Assumption: unknown values should not override fallback; risk: misconfig masked; invariant: boolean output; handling: return fallback.
  return fallback;
};
