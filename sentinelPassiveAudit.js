// sentinelPassiveAudit.js
// Purpose: Redesign Audit-Safe into passive logging + Sentinel fallback
// OpenAI SDK-compatible

import fs from "fs";
import { fileURLToPath } from "url";

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
  console.log(`🚀 Running command: ${name}`, payload);
  if (name === "generateReport") {
    await generateReport(payload.type);
  }
  // TODO: hook into actual backend modules (Backstage Booker, etc.)
  return true;
}

// ----------------------
// Report Generator
// ----------------------
async function generateReport(type) {
  await logAudit("REPORT_REQUESTED", { type });
  const timestamp = new Date().toISOString();
  const dir = "reports";
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const path = `${dir}/${type}.txt`;
  fs.writeFileSync(path, `Report generated at ${timestamp}\n`);
  await logAudit("REPORT_WRITTEN", { type, path });
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

// ----------------------
// Main
// ----------------------
async function main() {
  await executeCommand("generateReport", { type: "daily" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
