#!/usr/bin/env node
/**
 * Purge + Redeploy for GPT-5 Orchestration Shell
 * Compatible with OpenAI Node.js SDK v4.x/v5.x
 * Run in your Codex AI or Node environment
 * 
 * This script demonstrates the exact functionality from the problem statement
 * while integrating with the ARCANOS infrastructure.
 */

import OpenAI from "openai";
import fs from "fs";
import { resetOrchestrationShell, getOrchestrationShellStatus } from "./dist/services/orchestrationShell.js";

// Initialize client (make sure your OPENAI_API_KEY is set in env)
let client = null;
try {
  if (process.env.OPENAI_API_KEY || process.env.API_KEY) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || process.env.API_KEY,
    });
  }
} catch (error) {
  console.warn("⚠️ OpenAI client initialization failed:", error.message);
}

// Orchestration reset function - standalone version
async function resetOrchestrationShellStandalone() {
  console.log("🔄 Starting GPT-5 Orchestration Shell purge...");

  if (!client) {
    console.warn("⚠️ OPENAI_API_KEY not configured - using ARCANOS integrated version");
    
    // Use the integrated ARCANOS version
    const result = await resetOrchestrationShell({
      agentId: 'demo-cli',
      sessionId: 'standalone'
    });
    console.log(result.success ? "✅" : "❌", result.message);
    
    if (result.logs) {
      result.logs.forEach(log => console.log(log));
    }
    return;
  }

  try {
    // Step 1: Isolate module
    console.log("📦 Isolating orchestration shell...");
    await client.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "system",
          content:
            "Isolate orchestration shell module to prevent interference with other services.",
        },
      ],
    });

    // Step 2: Purge stale memory / state
    console.log("🧹 Purging memory state...");
    await client.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "system",
          content:
            "Clear all cached context, persistent variables, and stored configs in orchestration shell.",
        },
      ],
    });

    // Step 3: Redeploy with fallback safeguards
    console.log("🚀 Redeploying with safeguards...");
    await client.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "system",
          content:
            "Redeploy orchestration shell module with fallback safeguards enabled. Apply 'rebirth-osiris' v1.04.",
        },
      ],
    });

    console.log("✅ GPT-5 orchestration shell has been purged and redeployed.");
  } catch (err) {
    console.error("❌ Error during orchestration reset:", err);
  }
}

// Enhanced version with ARCANOS integration
async function demonstrateArcanosIntegration() {
  console.log("\n=== 🧠 ARCANOS Integration Demo ===");
  
  // Get current status
  console.log("📊 Checking orchestration shell status...");
  const status = await getOrchestrationShellStatus();
  console.log("Status:", {
    active: status.active,
    model: status.model,
    memoryEntries: status.memoryEntries
  });
  
  // Perform reset with full ARCANOS integration
  console.log("\n🔄 Performing reset with ARCANOS integration...");
  const result = await resetOrchestrationShell({
    agentId: 'demo-cli',
    sessionId: 'integration'
  });
  console.log("Reset result:", {
    success: result.success,
    stages: result.meta.stages,
    gpt5Model: result.meta.gpt5Model,
    safeguardsApplied: result.meta.safeguardsApplied
  });
  
  // Show detailed logs
  if (result.logs) {
    console.log("\n📝 Detailed logs:");
    result.logs.forEach(log => console.log("  ", log));
  }
}

// Check command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'integrated';

console.log("🚀 GPT-5 Orchestration Shell - ARCANOS Edition");
console.log(`Running mode: ${command}`);
console.log("OpenAI SDK version:", "5.x (compatible with 4.x)");
console.log("=" .repeat(50));

switch (command) {
  case 'standalone':
    // Execute original standalone version
    resetOrchestrationShellStandalone().catch((err) => {
      console.error("❌ Error during orchestration reset:", err);
    });
    break;
    
  case 'status':
    // Just show status
    getOrchestrationShellStatus().then(status => {
      console.log("📊 Orchestration Shell Status:");
      console.log("  Active:", status.active);
      console.log("  Model:", status.model);
      console.log("  Memory Entries:", status.memoryEntries);
      if (status.lastReset) {
        console.log("  Last Reset:", status.lastReset);
      }
    }).catch(console.error);
    break;
    
  case 'integrated':
  default:
    // Execute with full ARCANOS integration
    demonstrateArcanosIntegration().catch((err) => {
      console.error("❌ Error during ARCANOS integration demo:", err);
    });
    break;
}