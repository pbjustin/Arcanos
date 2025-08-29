/**
 * ARCANOS Codex Agent Patch
 * Railway-compatible single file deployment
 * Replaces legacy Codex with GPT-5 Codex Agent (2025)
 */

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// ---- Inline Environment Config ----
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-...(your key)";
process.env.MODEL_NAME = process.env.MODEL_NAME || "gpt-5-codex-2025";
process.env.AGENT_ROLE = process.env.AGENT_ROLE || "arcanos-audit-agent";
process.env.MEMORY_ENABLED = process.env.MEMORY_ENABLED || "true";
process.env.TIMEOUT = process.env.TIMEOUT || "30";

// ---- OpenAI SDK Init ----
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---- ARCANOS Routing Config ----
const routingConfig = {
  modules: {
    codex: {
      engine: "openai",
      model: process.env.MODEL_NAME,
      mode: "agent",
      features: ["ide", "cli", "github", "cloud"],
    },
  },
  routing: {
    "ARCANOS:BUILD": "codex",
    "ARCANOS:WRITE": "codex",
    "ARCANOS:GUIDE": "codex",
    "ARCANOS:RESEARCH": "gpt-5",
    "ARCANOS:AUDIT": "gpt-5",
  },
};

// ---- Agent Function ----
async function runCodexAgent(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: process.env.MODEL_NAME,
      messages: [
        { role: "system", content: `You are ${process.env.AGENT_ROLE}.` },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

    console.log("✅ Codex Response:");
    console.log(response.choices[0].message.content);
  } catch (error) {
    console.error("❌ Codex Agent Error:", error);
  }
}

// ---- Startup ----
console.log("🚀 Starting ARCANOS Codex Agent...");
console.log("🔧 Routing Config:", JSON.stringify(routingConfig, null, 2));

// Run a test request (you can remove this in Railway)
runCodexAgent("Write a Python function that computes factorial recursively.");
