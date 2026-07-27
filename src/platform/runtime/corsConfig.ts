import type { CorsOptions } from 'cors';

export interface ParsedCorsAllowedOrigins {
  origins: string[];
  valid: boolean;
}

type CorsOriginCallback = Exclude<
  NonNullable<CorsOptions['origin']>,
  boolean | string | RegExp | Array<boolean | string | RegExp>
>;

export interface RuntimeCorsConfig {
  origin: boolean | CorsOriginCallback;
  credentials: boolean;
}

function normalizeCorsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.origin === 'null'
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.pathname !== '/'
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Parse the deployment browser-origin allowlist as exact HTTP(S) origins.
 *
 * One malformed member invalidates the complete list so a typo cannot leave a
 * partially enabled cross-origin policy. Duplicate canonical origins collapse
 * without changing their first-seen order.
 */
export function parseCorsAllowedOrigins(
  configuredValue: string | undefined,
): ParsedCorsAllowedOrigins {
  if (!configuredValue || configuredValue.trim().length === 0) {
    return {
      origins: [],
      valid: false,
    };
  }

  const configuredOrigins = configuredValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedOrigins: string[] = [];
  const seenOrigins = new Set<string>();

  if (configuredOrigins.length === 0) {
    return {
      origins: [],
      valid: false,
    };
  }

  for (const configuredOrigin of configuredOrigins) {
    const normalizedOrigin = normalizeCorsOrigin(configuredOrigin);
    if (!normalizedOrigin) {
      return {
        origins: [],
        valid: false,
      };
    }

    if (!seenOrigins.has(normalizedOrigin)) {
      seenOrigins.add(normalizedOrigin);
      normalizedOrigins.push(normalizedOrigin);
    }
  }

  return {
    origins: normalizedOrigins,
    valid: true,
  };
}

export function isValidCorsAllowedOrigins(configuredValue: string): boolean {
  return parseCorsAllowedOrigins(configuredValue).valid;
}

/**
 * Resolve the global Express CORS policy.
 *
 * Local development preserves the historical reflected-origin behavior.
 * Every other environment defaults to no browser CORS and enables credentialed
 * CORS only when the complete configured allowlist is valid.
 */
export function resolveRuntimeCorsConfig(
  nodeEnv: string,
  configuredValue: string | undefined,
): RuntimeCorsConfig {
  if (nodeEnv === 'development') {
    return {
      origin: true,
      credentials: true,
    };
  }

  const parsedAllowedOrigins = parseCorsAllowedOrigins(configuredValue);
  if (!parsedAllowedOrigins.valid) {
    return {
      origin: false,
      credentials: false,
    };
  }

  const allowedOrigins = new Set(parsedAllowedOrigins.origins);
  return {
    origin: (requestOrigin, callback) => {
      callback(
        null,
        typeof requestOrigin === 'string' && allowedOrigins.has(requestOrigin),
      );
    },
    credentials: true,
  };
}
