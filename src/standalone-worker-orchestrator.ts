// 🔁 OpenAI SDK-Compatible Worker Initialization & Fallback Logic

import OpenAI from "openai"; // OpenAI SDK v4+
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Orchestrate worker logic safely.
 * Ensures OpenAI function orchestration fallback is respected.
 */
async function orchestrateWorker(task: { name: string }) {
  if (!task?.name) throw new Error("Worker task missing 'name'");

  // You can customize this OpenAI call
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo", // or fine-tuned version
    messages: [
      { role: "system", content: `Initialize and execute worker logic for '${task.name}'` },
      { role: "user", content: `Start '${task.name}' orchestration.` }
    ]
  });

  console.log(`✅ [${task.name}] orchestration started via OpenAI`);
  return response.choices[0].message.content;
}

// 🧩 Worker Init with fallback orchestration
async function registerWorker(name: string, orchestrator = orchestrateWorker) {
  if (typeof orchestrator !== "function") {
    console.warn(`⚠️ Worker '${name}' registration failed: orchestrator invalid.`);
    return;
  }

  try {
    const result = await orchestrator({ name });
    console.log(`🔧 Worker '${name}' registered:`, result);
  } catch (err: any) {
    console.error(`❌ Error initializing worker '${name}':`, err.message);
  }
}

// 🔁 Register all critical AI workers
["goalTracker", "maintenanceScheduler", "emailDispatcher", "auditProcessor"]
  .forEach(worker => registerWorker(worker));

export { orchestrateWorker, registerWorker };