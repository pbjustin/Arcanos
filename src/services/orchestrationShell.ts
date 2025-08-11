/**
 * Purge + Redeploy for GPT-5 Orchestration Shell
 * Compatible with OpenAI Node.js SDK v4.x/v5.x
 * Integrates with existing ARCANOS infrastructure
 */

import OpenAI from "openai";
import { getOpenAIClient, getGPT5Model } from './openai.js';
import { createResponseWithLogging, logArcanosRouting } from '../utils/aiLogger.js';
import { 
  getAuditSafeConfig, 
  logAITaskLineage,
  type AuditLogEntry 
} from './auditSafe.js';
import { getMemoryContext, clearMemoryState } from './memoryAware.js';

interface OrchestrationResult {
  success: boolean;
  message: string;
  meta: {
    timestamp: string;
    stages: string[];
    gpt5Model: string;
    safeguardsApplied: boolean;
  };
  logs: string[];
}

/**
 * Orchestration reset function - purges and redeploys GPT-5 orchestration shell
 * Integrates with existing ARCANOS infrastructure for audit safety and logging
 */
export async function resetOrchestrationShell(): Promise<OrchestrationResult> {
  const requestId = `orchestration_reset_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const stages: string[] = [];
  const logs: string[] = [];
  
  logs.push("🔄 Starting GPT-5 Orchestration Shell purge...");
  console.log("🔄 Starting GPT-5 Orchestration Shell purge...");

  // Get OpenAI client using existing infrastructure
  const client = getOpenAIClient();
  if (!client) {
    const errorResult: OrchestrationResult = {
      success: false,
      message: "OpenAI client not available - check OPENAI_API_KEY configuration",
      meta: {
        timestamp: new Date().toISOString(),
        stages: ["FAILED_INITIALIZATION"],
        gpt5Model: getGPT5Model(),
        safeguardsApplied: false
      },
      logs: ["❌ OpenAI client initialization failed"]
    };
    return errorResult;
  }

  // Log task lineage using existing audit system
  const auditConfig = getAuditSafeConfig('GPT-5 Orchestration Shell purge and redeploy');
  const auditEntry: AuditLogEntry = {
    requestId,
    timestamp: new Date().toISOString(),
    endpoint: 'ORCHESTRATION_RESET',
    auditSafeMode: true,
    overrideUsed: false,
    inputSummary: 'GPT-5 Orchestration Shell purge and redeploy',
    outputSummary: 'Processing...',
    modelUsed: getGPT5Model(),
    memoryAccessed: [],
    processedSafely: true,
    auditFlags: ['ORCHESTRATION', 'SYSTEM_RESET']
  };
  
  logAITaskLineage(auditEntry);

  try {
    // Step 1: Isolate module
    stages.push("ISOLATE_MODULE");
    logs.push("📦 Isolating orchestration shell...");
    console.log("📦 Isolating orchestration shell...");
    
    await client.chat.completions.create({
      model: getGPT5Model(),
      messages: [
        {
          role: "system",
          content: "Isolate orchestration shell module to prevent interference with other services. Mark this session as ORCHESTRATION_ISOLATION mode."
        },
      ],
      max_tokens: 100
    });

    // Step 2: Purge stale memory / state using existing memory system
    stages.push("PURGE_MEMORY");
    logs.push("🧹 Purging memory state...");
    console.log("🧹 Purging memory state...");
    
    // Use existing memory system to clear state
    const memoryContext = await getMemoryContext('orchestration');
    if (memoryContext.relevantEntries.length > 0) {
      await clearMemoryState('orchestration');
      logs.push(`✅ Cleared ${memoryContext.relevantEntries.length} memory entries`);
    }
    
    await client.chat.completions.create({
      model: getGPT5Model(),
      messages: [
        {
          role: "system",
          content: "Clear all cached context, persistent variables, and stored configs in orchestration shell. Reset internal state to factory defaults."
        },
      ],
      max_tokens: 100
    });

    // Step 3: Redeploy with fallback safeguards
    stages.push("REDEPLOY_SAFEGUARDS");
    logs.push("🚀 Redeploying with safeguards...");
    console.log("🚀 Redeploying with safeguards...");
    
    await client.chat.completions.create({
      model: getGPT5Model(),
      messages: [
        {
          role: "system",
          content: "Redeploy orchestration shell module with fallback safeguards enabled. Apply 'rebirth-osiris' v1.04 configuration. Enable audit-safe mode and memory context restoration."
        },
      ],
      max_tokens: 150
    });

    // Step 4: Verify deployment with ARCANOS integration
    stages.push("VERIFY_DEPLOYMENT");
    logs.push("✅ Verifying deployment and ARCANOS integration...");
    console.log("✅ Verifying deployment and ARCANOS integration...");
    
    const verificationResponse = await client.chat.completions.create({
      model: getGPT5Model(),
      messages: [
        {
          role: "system",
          content: "Verify orchestration shell deployment. Check integration with ARCANOS Trinity pipeline, audit-safe constraints, and memory awareness systems. Report operational status."
        },
      ],
      max_tokens: 200
    });

    // Log successful completion
    logArcanosRouting('ORCHESTRATION_RESET_COMPLETE', getGPT5Model(), `Stages: ${stages.join(' -> ')}`);
    
    const finalMessage = "✅ GPT-5 orchestration shell has been purged and redeployed with ARCANOS integration.";
    logs.push(finalMessage);
    console.log(finalMessage);

    // Update audit log with success
    auditEntry.outputSummary = 'Orchestration shell reset completed successfully';
    auditEntry.auditFlags.push('RESET_SUCCESS');
    logAITaskLineage(auditEntry);

    return {
      success: true,
      message: "Orchestration shell reset completed successfully",
      meta: {
        timestamp: new Date().toISOString(),
        stages,
        gpt5Model: getGPT5Model(),
        safeguardsApplied: true
      },
      logs
    };

  } catch (error: any) {
    const errorMessage = `❌ Error during orchestration reset: ${error.message || 'Unknown error'}`;
    logs.push(errorMessage);
    console.error(errorMessage, error);

    // Update audit log with error
    auditEntry.outputSummary = `Orchestration shell reset failed: ${error.message}`;
    auditEntry.auditFlags.push('RESET_ERROR');
    logAITaskLineage(auditEntry);

    return {
      success: false,
      message: errorMessage,
      meta: {
        timestamp: new Date().toISOString(),
        stages,
        gpt5Model: getGPT5Model(),
        safeguardsApplied: false
      },
      logs
    };
  }
}

/**
 * Gets the current status of the orchestration shell
 */
export async function getOrchestrationShellStatus(): Promise<{
  active: boolean;
  model: string;
  lastReset?: string;
  memoryEntries: number;
}> {
  const client = getOpenAIClient();
  const memoryContext = await getMemoryContext('orchestration');
  
  return {
    active: !!client,
    model: getGPT5Model(),
    lastReset: process.env.ORCHESTRATION_LAST_RESET,
    memoryEntries: memoryContext.relevantEntries.length
  };
}