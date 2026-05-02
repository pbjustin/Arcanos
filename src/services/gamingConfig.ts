import { getEnvNumber } from "@platform/runtime/env.js";

export const DEFAULT_GAMING_MODULE_TIMEOUT_MS = 60_000;
export const DEFAULT_GAMING_WEB_CONTEXT_CHARS = 5_000;

function readIntegerEnv(key: string, defaultValue: number, minValue: number): number {
  const value = Math.trunc(getEnvNumber(key, defaultValue));
  return Number.isFinite(value) && value >= minValue ? value : defaultValue;
}

export function getGamingModuleTimeoutMs(): number {
  return readIntegerEnv(
    "ARCANOS_GAMING_MODULE_TIMEOUT_MS",
    DEFAULT_GAMING_MODULE_TIMEOUT_MS,
    1
  );
}

export function getGamingWebContextMaxChars(): number {
  return readIntegerEnv(
    "ARCANOS_GAMING_WEB_CONTEXT_CHARS",
    DEFAULT_GAMING_WEB_CONTEXT_CHARS,
    0
  );
}
