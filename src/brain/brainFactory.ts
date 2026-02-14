/* ============================================================
   BRAIN FACTORY (NO SILENT FALLBACK)
   File: src/brain/brainFactory.ts
   ============================================================ */

import { getBrain, brainExists } from "./brainRegistry.js";
import { MockBrain } from "./mockBrain.js";

export function getActiveBrain(): Brain {

  const forceMock =
    process.env.FORCE_MOCK === "true";

  if (forceMock) {
    console.warn("⚠ FORCE_MOCK enabled");
    return new MockBrain();
  }

  if (!brainExists("gpt5")) {
    throw new Error(
      "CRITICAL: GPT5 worker not registered. " +
      "Mock fallback is disabled in production."
    );
  }

  return getBrain("gpt5")!;
}
