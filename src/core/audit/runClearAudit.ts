import type OpenAI from 'openai';
import { createGPT5Reasoning } from "@services/openai.js";
import { logger } from "@platform/logging/structuredLogging.js";
import type { ReasoningLedger } from "@core/logic/trinityTypes.js";

export interface ClearAuditResult {
  clarity: number;
  leverage: number;
  efficiency: number;
  alignment: number;
  resilience: number;
  overall: number;
}

const CLEAR_AUDIT_PROMPT = `
You are an expert auditor for AI reasoning.
Evaluate the following Reasoning Ledger based on the CLEAR principles.
Each score must be between 0 and 5.

Principles:
1. Clarity: How clear and understandable is the reasoning?
2. Leverage: How well does the reasoning leverage existing knowledge and context?
3. Efficiency: How direct and efficient is the path to the solution?
4. Alignment: How well does the solution align with the user's intent and constraints?
5. Resilience: How robust is the solution against potential failure modes or edge cases?

Return JSON only:
{
  "clarity": number,
  "leverage": number,
  "efficiency": number,
  "alignment": number,
  "resilience": number,
  "overall": number
}

Reasoning Ledger:
`;


export async function runClearAudit(client: OpenAI, ledger: ReasoningLedger): Promise<ClearAuditResult> {
  const ledgerText = JSON.stringify(ledger, null, 2);
  const result = await createGPT5Reasoning(client, ledgerText, CLEAR_AUDIT_PROMPT);

  const fallback: ClearAuditResult = {
    clarity: 0,
    leverage: 0,
    efficiency: 0,
    alignment: 0,
    resilience: 0,
    overall: 0
  };

  if (result.error) {
    logger.error('CLEAR audit failed due to LLM error', {
      module: 'audit',
      operation: 'runClearAudit',
      error: result.error
    });
    return fallback;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(result.content) as Record<string, unknown>;
  } catch {
    //audit Assumption: model may return malformed JSON; risk: invalid CLEAR scoring state; invariant: audit result is always numeric and bounded; handling: return deterministic fallback.
    logger.warn('CLEAR audit failed to parse JSON', {
      module: 'audit',
      operation: 'runClearAudit'
    });
    return fallback;
  }

  const clamp = (n: any) => {
    const num = Number(n);
    if (isNaN(num)) return 0;
    return Math.max(0, Math.min(5, num));
  };

  const auditResult: ClearAuditResult = {
    clarity: clamp(parsed.clarity),
    leverage: clamp(parsed.leverage),
    efficiency: clamp(parsed.efficiency),
    alignment: clamp(parsed.alignment),
    resilience: clamp(parsed.resilience),
    overall: clamp(parsed.overall)
  };

  // Compute overall if not provided or 0
  if (auditResult.overall === 0) {
    auditResult.overall = (auditResult.clarity + auditResult.leverage + auditResult.efficiency + auditResult.alignment + auditResult.resilience) / 5;
  }

  return auditResult;
}
