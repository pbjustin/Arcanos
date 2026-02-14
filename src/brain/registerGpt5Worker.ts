/* ============================================================
   GPT5 WORKER REGISTRATION
   File: src/brain/registerGpt5Worker.ts
   ============================================================ */

import { registerBrain } from "./brainRegistry.js";

export async function registerGpt5Worker() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY missing. Cannot register GPT5 worker."
    );
  }

  const gpt5Worker: Brain = {
    async execute(payload: BrainPayload): Promise<BrainResponse> {
      return await callOpenAI(payload);
    }
  };

  registerBrain("gpt5", gpt5Worker);
}

// Replace with your actual OpenAI call
async function callOpenAI(payload: any) {
  throw new Error("OpenAI adapter not implemented");
}
