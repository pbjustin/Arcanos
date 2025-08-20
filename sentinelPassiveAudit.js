// sentinelPassiveAudit.js
// Purpose: Redesign Audit-Safe into passive logging + Sentinel fallback
// OpenAI SDK-compatible

import fs from "fs";

// ----------------------
// State
// ----------------------
let auditSafeMode = "passive"; // enforce passive-only
let sentinelActive = true;

// ----------------------
// Main Execution Wrapper
// ----------------------
export async function executeCommand(commandName, payload, executor = "user") {
  try {
    if (executor === "user") {
      console.log(`⚡ USER COMMAND: Executing '${commandName}' immediately.`);
      await runCommand(commandName, payload);
      await logAudit("USER_COMMAND_EXECUTED", { commandName, payload });
      return { success: true, override: true };
    }

    // AI-origin commands (normal ops)
    console.log(`🤖 AI COMMAND: Running '${commandName}'`);
    await runCommand(commandName, payload);
    await logAudit("AI_COMMAND_EXECUTED", { commandName, payload });
    return { success: true, override: false };
  } catch (err) {
    if (sentinelActive) {
      await handleSentinelFallback(commandName, payload, err);
    }
    throw err;
  }
}

// ----------------------
// Core Command Router
// ----------------------
async function runCommand(name, payload) {
  // TODO: hook into actual backend modules (Backstage Booker, etc.)
  console.log(`🚀 Running command: ${name}`, payload);
  return true;
}

// ----------------------
// Sentinel Fallback
// ----------------------
async function handleSentinelFallback(name, payload, error) {
  console.error(`🛡️ SENTINEL CAUGHT ERROR in '${name}':`, error.message);
  await logAudit("SENTINEL_ROLLBACK", { name, payload, error: error.message });
  // rollback logic here if needed
}

// ----------------------
// Passive Audit Logger
// ----------------------
async function logAudit(event, details) {
  const logLine = JSON.stringify({ ts: Date.now(), event, details }) + "\n";
  fs.appendFileSync("audit.log", logLine);
  console.log(`[AUDIT] ${event}`, details);
}
