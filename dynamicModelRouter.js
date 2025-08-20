// dynamicModelRouter.js
// Purpose: Route tasks between GPT-5 Thinker and GPT-5 Pro intelligently
// OpenAI SDK-compatible

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ----------------------
// Model Routing Rules
// ----------------------
function chooseModel(task) {
  // Lightweight tasks = Thinker
  if (
    task.type === "simple" ||
    task.estimatedTokens < 1500 ||
    task.priority === "low"
  ) {
    return "gpt-5-thinker"; // Reasoning tier
  }

  // Heavy reasoning / complex planning = Pro
  if (
    task.type === "complex" ||
    task.estimatedTokens >= 1500 ||
    task.priority === "high" ||
    task.requiresLongContext
  ) {
    return "gpt-5-pro"; // Advanced reasoning tier
  }

  // Default to Thinker if uncertain
  return "gpt-5-thinker";
}

// ----------------------
// Core Execution Function
// ----------------------
export async function runTask(task) {
  const model = chooseModel(task);

  console.log(
    `⚡ Routing task '${task.name}' to model: ${model} (priority: ${task.priority})`
  );

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are the reasoning engine for ARCANOS." },
        { role: "user", content: task.prompt },
      ],
      max_tokens: task.maxTokens || 2000,
    });

    return {
      success: true,
      model,
      output: response.choices[0].message.content,
    };
  } catch (err) {
    console.error(`❌ Model execution failed: ${err.message}`);
    return { success: false, error: err.message, model };
  }
}

// ----------------------
// Example Task Definitions
// ----------------------
/*
const task1 = {
  name: "Roster Save",
  type: "simple",
  estimatedTokens: 800,
  priority: "low",
  prompt: "Summarize the current WWE roster save state.",
};

const task2 = {
  name: "Storyline Arc Planning",
  type: "complex",
  estimatedTokens: 3000,
  priority: "high",
  requiresLongContext: true,
  prompt: "Generate a 3-month storyline arc with branching outcomes.",
};

await runTask(task1); // → Thinker
await runTask(task2); // → Pro
*/
