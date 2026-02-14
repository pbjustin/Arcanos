/* ============================================================
   MOCK BRAIN (ONLY USED WHEN EXPLICITLY FORCED)
   File: src/brain/mockBrain.ts
   ============================================================ */

import { Brain } from "./brainRegistry.js";

export class MockBrain implements Brain {
  async execute(payload: any): Promise<any> {
    return {
      module: "MockBrain",
      activeModel: "MOCK",
      output_text: "Mock response",
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  }
}
