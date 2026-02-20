import type { Tier } from "@core/logic/trinityTier.js";
import { logger } from "@platform/logging/structuredLogging.js";

export interface EscalationEvent {
  runId: string;
  originalTier: Tier;
  escalatedTier: Tier;
  clearScoreInitial: number;
  clearScoreFinal: number;
  clearImprovement: number;
  latencyInitial: number;
  latencyFinal: number;
  tokenUsageInitial: number;
  tokenUsageFinal: number;
}

const escalationHistory: EscalationEvent[] = [];
const MAX_HISTORY = 1000;

export function trackEscalation(event: EscalationEvent): void {
  escalationHistory.push(event);
  if (escalationHistory.length > MAX_HISTORY) {
    escalationHistory.shift();
  }

  logger.info('Trinity Escalation Event', {
    module: 'analytics',
    operation: 'trackEscalation',
    ...event
  });
}

export function getEscalationHistory(): EscalationEvent[] {
  return [...escalationHistory];
}

export function getEscalationRate(): number {
  if (escalationHistory.length === 0) return 0;
  // This is a simplified rate. In a real system we'd need total runs too.
  // For Phase 5 auto-tuning, we'll need to track total runs.
  return 0; 
}
