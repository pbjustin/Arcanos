import { getEnv, getEnvBoolean } from "@platform/runtime/env.js";
import { processJudgedResponseFeedback } from "@services/judgedResponseFeedback.js";
import type { ClearAuditResult } from "@core/audit/runClearAudit.js";
import type { ClearScoreScale } from "@shared/types/reinforcement.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";

export interface TrinityJudgedFeedbackInput {
  requestId: string;
  prompt: string;
  response: string;
  clearAudit?: ClearAuditResult;
  tier: 'simple' | 'complex' | 'critical';
  sessionId?: string;
  sourceEndpoint?: string;
  internalMode?: boolean;
  remainingBudgetMs?: number;
}

export interface TrinityJudgedFeedbackSummary {
  enabled: boolean;
  attempted: boolean;
  source: 'clear_audit';
  reason?: string;
  traceId?: string;
  accepted?: boolean;
  score?: number;
  scoreScale?: ClearScoreScale;
  normalizedScore?: number;
  persisted?: boolean;
}

const MINIMUM_JUDGED_FEEDBACK_BUDGET_MS = 2_000;
const DEFAULT_ALLOWED_TRINITY_JUDGED_ENDPOINTS = '*';

/**
 * Persist Trinity response quality judgment from CLEAR audit output.
 *
 * Purpose: convert CLEAR scores into judged-response feedback entries that improve future responses.
 * Inputs/outputs: Trinity response context + CLEAR score -> persistence summary metadata.
 * Edge cases: returns non-throwing skip reasons when disabled, budget-constrained, or CLEAR data is unavailable.
 */
export async function recordTrinityJudgedFeedback(
  input: TrinityJudgedFeedbackInput
): Promise<TrinityJudgedFeedbackSummary> {
  const enabled = getEnvBoolean('TRINITY_JUDGED_FEEDBACK_ENABLED', true);
  const allowedSourceEndpoints = parseAllowedSourceEndpoints(
    getEnv('TRINITY_JUDGED_ALLOWED_ENDPOINTS', DEFAULT_ALLOWED_TRINITY_JUDGED_ENDPOINTS)
  );
  //audit Assumption: operators may disable auto judged feedback during incidents; risk: unintended persistence load; invariant: disabled mode performs no writes; handling: explicit early-return skip summary.
  if (!enabled) {
    return {
      enabled: false,
      attempted: false,
      source: 'clear_audit',
      reason: 'disabled_by_env'
    };
  }

  //audit Assumption: budget-constrained requests should prioritize user response over persistence side-effects; risk: timeout regressions; invariant: judged persistence only runs with sufficient remaining budget; handling: skip when budget below threshold.
  if (
    typeof input.remainingBudgetMs === 'number' &&
    Number.isFinite(input.remainingBudgetMs) &&
    input.remainingBudgetMs < MINIMUM_JUDGED_FEEDBACK_BUDGET_MS
  ) {
    return {
      enabled: true,
      attempted: false,
      source: 'clear_audit',
      reason: 'insufficient_runtime_budget'
    };
  }

  //audit Assumption: CLEAR audit drives automated quality judgments; risk: low-signal records without score context; invariant: auto-judged persistence requires CLEAR audit data; handling: skip when unavailable.
  if (!input.clearAudit) {
    return {
      enabled: true,
      attempted: false,
      source: 'clear_audit',
      reason: 'clear_audit_unavailable'
    };
  }

  //audit Assumption: endpoint allowlisting should gate automated judged persistence to approved entrypoints; risk: unbounded writes from non-chat routes; invariant: only configured endpoints can persist auto judgments; handling: skip with explicit reason when disallowed.
  if (!isSourceEndpointAllowed(input.sourceEndpoint, allowedSourceEndpoints)) {
    const sourceEndpoint = input.sourceEndpoint ?? 'unknown';
    logger.warn(
      '[🧠 Trinity] Auto judged feedback skipped for disallowed source endpoint',
      {
        module: 'trinity',
        operation: 'judged-feedback-source-gate',
        requestId: input.requestId
      },
      {
        sourceEndpoint,
        allowedSourceEndpoints: allowedSourceEndpoints.wildcard
          ? '*'
          : Array.from(allowedSourceEndpoints.entries.values())
      }
    );
    return {
      enabled: true,
      attempted: false,
      source: 'clear_audit',
      reason: `source_endpoint_not_allowed:${sourceEndpoint}`
    };
  }

  const scoreScale: ClearScoreScale = '0-10';
  const score = Number((input.clearAudit.overall * 2).toFixed(3));
  const feedbackText =
    `Automated Trinity CLEAR audit overall=${input.clearAudit.overall.toFixed(2)}/5 for tier=${input.tier}.`;
  const improvementHints = buildImprovementHintsFromClearAudit(input.clearAudit);

  try {
    const judgedResult = await processJudgedResponseFeedback(
      {
        requestId: input.requestId,
        prompt: input.prompt,
        response: input.response,
        score,
        scoreScale,
        feedback: feedbackText,
        judge: 'trinity-clear-audit',
        improvements: improvementHints,
        metadata: {
          source: 'trinity_auto_judged_feedback',
          tier: input.tier,
          sessionId: input.sessionId,
          sourceEndpoint: input.sourceEndpoint,
          internalMode: input.internalMode ?? false,
          clearAudit: input.clearAudit
        }
      },
      input.requestId
    );

    return {
      enabled: true,
      attempted: true,
      source: 'clear_audit',
      traceId: judgedResult.traceId,
      accepted: judgedResult.accepted,
      score: judgedResult.score,
      scoreScale: judgedResult.scoreScale,
      normalizedScore: judgedResult.normalizedScore,
      persisted: judgedResult.persisted
    };
  } catch (error: unknown) {
    //audit Assumption: judged persistence failures should never fail user-facing response flow; risk: partial request failure due side-effect write path; invariant: function always returns summary object; handling: warn and return failure summary.
    const errorMessage = resolveErrorMessage(error);
    logger.warn(
      '[🧠 Trinity] Auto judged feedback persistence failed',
      {
        module: 'trinity',
        operation: 'judged-feedback-persist-failure',
        requestId: input.requestId
      },
      {
        errorMessage,
        sourceEndpoint: input.sourceEndpoint
      }
    );
    return {
      enabled: true,
      attempted: true,
      source: 'clear_audit',
      reason: `persist_failed:${errorMessage}`
    };
  }
}

/**
 * Derive concise improvement hints from CLEAR audit dimension scores.
 *
 * Purpose: convert low CLEAR dimensions into actionable feedback guidance for future responses.
 * Inputs/outputs: CLEAR audit scores -> deduplicated improvement hint list.
 * Edge cases: returns at least one generic hint when all dimensions are above threshold.
 */
export function buildImprovementHintsFromClearAudit(clearAudit: ClearAuditResult): string[] {
  const hints: string[] = [];
  const LOW_SCORE_THRESHOLD = 3;

  //audit Assumption: low clarity indicates missing structure and explicitness; risk: repeated ambiguity; invariant: hint emitted when clarity below threshold; handling: append targeted clarity guidance.
  if (clearAudit.clarity < LOW_SCORE_THRESHOLD) {
    hints.push('Increase structure clarity and make assumptions explicit.');
  }
  if (clearAudit.leverage < LOW_SCORE_THRESHOLD) {
    hints.push('Use more relevant context and prior memory evidence.');
  }
  if (clearAudit.efficiency < LOW_SCORE_THRESHOLD) {
    hints.push('Reduce unnecessary verbosity and prioritize direct execution steps.');
  }
  if (clearAudit.alignment < LOW_SCORE_THRESHOLD) {
    hints.push('Align output more tightly with user goals and stated constraints.');
  }
  if (clearAudit.resilience < LOW_SCORE_THRESHOLD) {
    hints.push('Call out edge cases and failure handling strategies explicitly.');
  }

  //audit Assumption: high-scoring outputs still benefit from reinforcement artifacts; risk: empty improvement arrays reduce downstream context usefulness; invariant: non-empty hint list; handling: add generic reinforcement hint.
  if (hints.length === 0) {
    hints.push('Maintain current response quality while preserving deterministic structure.');
  }

  return hints;
}

interface AllowedSourceEndpointsPolicy {
  wildcard: boolean;
  entries: Set<string>;
}

function parseAllowedSourceEndpoints(rawValue: string): AllowedSourceEndpointsPolicy {
  const parsedValues = rawValue
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => value.length > 0);
  const wildcard = parsedValues.includes('*');
  return {
    wildcard,
    entries: new Set(parsedValues.filter(value => value !== '*'))
  };
}

function isSourceEndpointAllowed(
  sourceEndpoint: string | undefined,
  policy: AllowedSourceEndpointsPolicy
): boolean {
  if (policy.wildcard) {
    return true;
  }
  if (!sourceEndpoint || sourceEndpoint.trim().length === 0) {
    return false;
  }
  return policy.entries.has(sourceEndpoint.trim().toLowerCase());
}
