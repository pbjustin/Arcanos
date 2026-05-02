import { getEnvIntegerAtLeast } from "@platform/runtime/env.js";

export const DEFAULT_GAMING_MODULE_TIMEOUT_MS = 60_000;
export const DEFAULT_GAMING_WEB_CONTEXT_CHARS = 5_000;

export function getGamingModuleTimeoutMs(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_MODULE_TIMEOUT_MS",
    DEFAULT_GAMING_MODULE_TIMEOUT_MS,
    1
  );
}

export function getGamingWebContextMaxChars(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_WEB_CONTEXT_CHARS",
    DEFAULT_GAMING_WEB_CONTEXT_CHARS,
    0
  );
}
