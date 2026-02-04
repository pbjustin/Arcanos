import { getArcanosSystemPrompt, getArcanosUserPrompt } from '../../config/prompts.js';
import { getEnv } from '../../config/env.js';
import type { HealthCheckReport } from '../../utils/diagnostics.js';
import type { MemoryContext } from '../../services/memoryAware.js';
import { applyAuditSafeConstraints, type AuditSafeConfig } from '../../services/auditSafe.js';

/**
 * Get the ARCANOS system prompt from configuration
 */
function getSystemPrompt(): string {
  return getArcanosSystemPrompt();
}

/**
 * Enhanced system prompt that includes memory context and audit-safe constraints
 * @confidence 1.0 - Type-safe prompt generation
 */
export function createEnhancedSystemPrompt(
  memoryContext: MemoryContext,
  auditConfig: AuditSafeConfig,
  health: HealthCheckReport
): string {
  const systemPrompt = getSystemPrompt();
  const basePrompt = `${systemPrompt}

CURRENT SYSTEM STATUS:
- Memory Usage: ${health.summary}
- Node.js Version: ${process.version}
- Platform: ${process.platform}
- Architecture: ${process.arch}
- Environment: ${getEnv('NODE_ENV') || 'development'}
- Uptime: ${process.uptime().toFixed(1)}s

${memoryContext.memoryPrompt}`;

  // Apply audit-safe constraints
  //audit Assumption: audit-safe constraints must be applied before sending
  const { systemPrompt: auditSafePrompt } = applyAuditSafeConstraints(
    basePrompt,
    '', // User prompt handled separately
    auditConfig
  );

  return auditSafePrompt;
}

/**
 * Wrap prompt before sending to ARCANOS with diagnostic format and memory context
 */
export const arcanosPrompt = (userInput: string, memoryContext?: MemoryContext): string => {
  return getArcanosUserPrompt(userInput, memoryContext?.contextSummary);
};
