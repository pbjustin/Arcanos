/* ============================================================
   SERVER BOOTSTRAP
   File: src/server/bootstrap.ts
   ============================================================ */

import { registerGpt5Worker } from "../brain/registerGpt5Worker.js";
import { logger } from "@platform/logging/structuredLogging.js";

const bootstrapLogger = logger.child({ module: "bootstrap" });

/**
 * Bootstraps server dependencies required before request handling starts.
 * Inputs: none.
 * Outputs: resolves when bootstrap registration completes.
 * Edge case behavior: skips GPT5 worker registration when FORCE_MOCK is "true".
 */
export async function bootstrap(): Promise<void> {
  bootstrapLogger.info("Bootstrapping ARCANOS...");

  //audit Assumption: FORCE_MOCK controls deterministic mock mode; Failure risk: registering real worker when mock mode is required; Expected invariant: GPT5 registration only occurs when FORCE_MOCK !== "true"; Handling strategy: explicit branch with structured logs.
  if (process.env.FORCE_MOCK !== "true") {
    await registerGpt5Worker();
    bootstrapLogger.info("GPT5 worker registered.");
  } else {
    bootstrapLogger.info("Running in FORCE_MOCK mode.");
  }
}
