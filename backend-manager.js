// File: backend-manager.js
// Purpose: Enforce creative-first pipeline priority for BackstageBooker
//          while keeping audit logs isolated and silent.
//
// Audit-Safe Modes Supported: true | false | passive
// Resilience Patch: rollback isolation + failsafe handler

import fs from "fs";
import path from "path";

// ----------------------
// Pipeline Definitions
// ----------------------

const pipelineMap = {
  generate_summary: "mad_writer/BackstageBook",
  analyze_tone: "pattern_1755662753967",
  deliver_response: "frontend_render/sendToUser",
  audit_log: "audit/writeToLog"
};

const pipelineOrder = [
  "generate_summary", // creative output first
  "analyze_tone",     // optional NLP checks
  "deliver_response", // send to user
  "audit_log"         // silent audit logging (never shown to user)
];

// ----------------------
// Audit-Safe Manager
// ----------------------

let auditSafeMode = "passive"; // default

export function setAuditSafeMode(mode) {
  if (!["true", "false", "passive"].includes(mode)) {
    throw new Error("Invalid Audit-Safe mode");
  }
  auditSafeMode = mode;
  console.log(`\uD83D\uDD10 Audit-Safe mode set to: ${auditSafeMode}`);
}

export function getAuditSafeMode() {
  return auditSafeMode;
}

// ----------------------
// Pipeline Executor
// ----------------------

export async function runPipeline(input) {
  try {
    let creativeOutput = null;

    for (const stage of pipelineOrder) {
      switch (stage) {
        case "generate_summary":
          creativeOutput = await generateCreative(input);
          break;

        case "analyze_tone":
          if (creativeOutput) {
            await analyzeTone(creativeOutput);
          }
          break;

        case "deliver_response":
          if (creativeOutput) {
            deliverToUser(creativeOutput);
          }
          break;

        case "audit_log":
          logAuditEvent(input, creativeOutput);
          break;
      }
    }

    return creativeOutput;
  } catch (err) {
    console.error("\u274C Pipeline error:", err.message);
    return fallbackResponse;
  }
}

// ----------------------
// Stage Implementations
// ----------------------

async function generateCreative(input) {
  // Placeholder for OpenAI SDK creative generation
  return {
    type: "creative_review",
    content: `\uD83D\uDCD6 Creative Review for: ${input}`
  };
}

async function analyzeTone(output) {
  console.log("Analyzing tone for output length:", output.content.length);
}

function deliverToUser(output) {
  console.log("\u2705 Delivering creative output:", output.content);
}

function logAuditEvent(input, output) {
  if (auditSafeMode === "false") return; // skip audit if disabled

  const auditPath = path.join(process.cwd(), "audit_logs.json");
  const logEntry = {
    timestamp: Date.now(),
    mode: auditSafeMode,
    input,
    outputType: output?.type || "none",
  };

  let logs = [];
  if (fs.existsSync(auditPath)) {
    logs = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
  }
  logs.push(logEntry);
  fs.writeFileSync(auditPath, JSON.stringify(logs, null, 2));

  if (auditSafeMode === "passive") {
    console.log("\u26A0\uFE0F Passive audit log written (silent).");
  } else {
    console.log("\uD83D\uDD12 Strict audit log written.");
  }
}

// ----------------------
// Fallback Handler
// ----------------------

const fallbackResponse = {
  type: "fallback",
  content: "\u26A0\uFE0F Creative pipeline failed. Rolled back to safe output."
};

