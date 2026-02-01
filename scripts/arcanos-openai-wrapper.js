/**
 * ARCANOS — BULLETPROOF OpenAI Call Wrapper
 * Fixes:
 * - content:null
 * - bad fallbacks
 * - model-specific params
 */

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---- HARD MESSAGE SANITIZER ----
function sanitizeMessages(messages) {
  return messages.map((m, i) => {
    if (typeof m.content !== "string" || m.content.trim() === "") {
      throw new Error(
        `ARCANOS_SCHEMA_VIOLATION: messages[${i}].content is invalid`
      );
    }
    return m;
  });
}

// ---- MESSAGE BUILDER (ALWAYS STRING) ----
function buildMessages(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("ARCANOS_INPUT_ERROR: prompt must be a non-empty string");
  }

  return sanitizeMessages([
    {
      role: "system",
      content: "You are ARCANOS, a logic-first operating intelligence."
    },
    {
      role: "user",
      content: prompt
    }
  ]);
}

// ---- MODEL-SAFE PARAMS ----
function modelParams(model) {
  if (model.startsWith("gpt-5")) {
    return { max_completion_tokens: 1000 };
  }
  return { max_tokens: 1000 };
}

// ---- SAFE COMPLETION ATTEMPT ----
async function attemptCompletion(model, prompt) {
  const messages = buildMessages(prompt);

  return openai.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
    ...modelParams(model)
  });
}

// ---- MAIN ASK HANDLER LOGIC ----
export async function runAsk(prompt) {
  const models = [
    "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote",
    "gpt-5.1"
  ];

  let lastError;

  for (const model of models) {
    try {
      return await attemptCompletion(model, prompt);
    } catch (err) {
      console.error(`[MODEL FAILED] ${model}:`, err.message);
      lastError = err;
    }
  }

  throw new Error(
    `All models failed safely. Last error: ${lastError.message}`
  );
}
