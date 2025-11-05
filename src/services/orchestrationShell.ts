/**
 * Purge + Redeploy for GPT-5 Orchestration Shell
 * Compatible with OpenAI Node.js SDK v4.x/v5.x
 * Integrates with existing ARCANOS infrastructure
 */

import { getOpenAIClient, getGPT5Model, call_gpt5_strict } from './openai.js';
import { generateRequestId } from '../utils/idGenerator.js';
import {
  ISOLATE_MODULE_PROMPT,
  PURGE_MEMORY_PROMPT,
  REDEPLOY_SAFEGUARDS_PROMPT,
  VERIFY_DEPLOYMENT_PROMPT
} from '../config/orchestrationPrompts.js';
import { logArcanosRouting } from '../utils/aiLogger.js';
import { initializeGPT5Orchestration, type GPT5OrchestrationConfig } from './orchestrationInit.js';
import { 
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
export async function resetOrchestrationShell(initConfig: GPT5OrchestrationConfig): Promise<OrchestrationResult> {
  const requestId = generateRequestId('orchestration_reset');
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
    await initializeGPT5Orchestration(initConfig);

    // Step 1: Isolate module
    stages.push("ISOLATE_MODULE");
    logs.push("📦 Isolating orchestration shell...");
    console.log("📦 Isolating orchestration shell...");
    
    await call_gpt5_strict(ISOLATE_MODULE_PROMPT, {
      max_completion_tokens: 100
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
    
    await call_gpt5_strict(PURGE_MEMORY_PROMPT, {
      max_completion_tokens: 100
    });

    // Step 3: Redeploy with fallback safeguards
    stages.push("REDEPLOY_SAFEGUARDS");
    logs.push("🚀 Redeploying with safeguards...");
    console.log("🚀 Redeploying with safeguards...");
    
    await call_gpt5_strict(REDEPLOY_SAFEGUARDS_PROMPT, {
      max_completion_tokens: 150
    });

    // Step 4: Verify deployment with ARCANOS integration
    stages.push("VERIFY_DEPLOYMENT");
    logs.push("✅ Verifying deployment and ARCANOS integration...");
    console.log("✅ Verifying deployment and ARCANOS integration...");
    
    await call_gpt5_strict(VERIFY_DEPLOYMENT_PROMPT, {
      max_completion_tokens: 200
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