/* ============================================================
   SERVER BOOTSTRAP
   File: src/server/bootstrap.ts
   ============================================================ */

import { registerGpt5Worker } from "../brain/registerGpt5Worker.js";

export async function bootstrap() {

  console.log("Bootstrapping ARCANOS...");

  if (process.env.FORCE_MOCK !== "true") {
    await registerGpt5Worker();
    console.log("GPT5 worker registered.");
  } else {
    console.log("Running in FORCE_MOCK mode.");
  }
}
