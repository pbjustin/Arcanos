/* ============================================================
   DISPATCH INTEGRATION
   File: src/controllers/dispatchControllerV9.ts
   ============================================================ */

import { getActiveBrain } from "../brain/brainFactory.js";

export async function dispatchControllerV9(
  prompt: string,
  sessionId: string,
  lineageId: string
) {

  const brain = getActiveBrain();

  const response = await brain.execute({
    prompt,
    sessionId,
    lineageId
  });

  return response;
}
