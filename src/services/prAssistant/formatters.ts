import { PR_ASSISTANT_MESSAGES } from '../../config/prAssistantMessages.js';
import { formatCheckLabel } from './utils.js';
import type { CheckResult, PRAnalysisResult } from './types.js';

/**
 * Purpose: Produce a high-level approval summary based on check statuses.
 * Inputs/Outputs: checks object, allPass flag, hasWarnings flag; returns summary string.
 * Edge cases: Defaults to rejection when not all pass and no warnings.
 */
export function generateSummary(checks: PRAnalysisResult['checks'], allPass: boolean, hasWarnings: boolean): string {
  //audit assumption: allPass overrides warnings; failure risk: conflicting flags; expected invariant: flags derived from checks; handling: order checks.
  if (allPass) {
    return PR_ASSISTANT_MESSAGES.summary.approved;
  }

  //audit assumption: warnings allowed without failures; failure risk: misclassification; expected invariant: hasWarnings reflects checks; handling: warning branch.
  if (hasWarnings) {
    return PR_ASSISTANT_MESSAGES.summary.conditional;
  }

  //audit assumption: remaining cases are failures; failure risk: hidden errors; expected invariant: no-pass + no-warning implies failure; handling: reject message.
  return PR_ASSISTANT_MESSAGES.summary.rejected;
}

/**
 * Purpose: Assemble human-readable reasoning for failed/warned checks.
 * Inputs/Outputs: checks object; returns markdown-ready reasoning string.
 * Edge cases: Returns success rationale when no issues are found.
 */
export function generateReasoning(checks: PRAnalysisResult['checks']): string {
  const reasons: string[] = [];

  Object.entries(checks).forEach(([checkName, result]) => {
    //audit assumption: only warning/error statuses need reasoning; failure risk: missing context; expected invariant: success is optional; handling: branch by status.
    if (result.status === '❌') {
      reasons.push(`**${checkName}**: ${result.message}`);
    } else if (result.status === '⚠️') {
      reasons.push(`**${checkName}**: ${result.message} (warning)`);
    }
  });

  //audit assumption: no reasons means all checks passed; failure risk: silent errors; expected invariant: reasons derived from checks; handling: success message fallback.
  if (reasons.length === 0) {
    return PR_ASSISTANT_MESSAGES.reasoning.noIssues;
  }

  return reasons.join('\n\n');
}

/**
 * Purpose: Provide actionable recommendations or success confirmations.
 * Inputs/Outputs: checks map; returns list of recommendation strings.
 * Edge cases: When all checks pass, return per-check confirmations.
 */
export function generateRecommendations(checks: Record<string, CheckResult>): string[] {
  const recommendations: string[] = [];
  const successDetails: string[] = [];

  Object.entries(checks).forEach(([checkName, result]) => {
    //audit assumption: checkName is camelCase; failure risk: unreadable labels; expected invariant: label is readable; handling: format helper.
    const label = formatCheckLabel(checkName);
    //audit assumption: only failing/warning checks need recommendations; failure risk: noisy output; expected invariant: success checks skip; handling: branch by status.
    if (result.status !== '✅') {
      recommendations.push(...result.details);
      return;
    }

    const detail = result.details?.[0];
    //audit assumption: success details might be empty; failure risk: unclear success; expected invariant: success summary exists; handling: fallback message.
    if (detail) {
      successDetails.push(`✅ ${label}: ${detail}`);
    } else {
      //audit assumption: success path should still inform; failure risk: vague success; expected invariant: message provided; handling: generic success detail.
      successDetails.push(PR_ASSISTANT_MESSAGES.recommendations.successFallback.replace('{label}', label));
    }
  });

  //audit assumption: no recommendations implies success; failure risk: missing info; expected invariant: successDetails filled; handling: return success summary or fallback.
  if (recommendations.length === 0) {
    const uniqueSuccess = [...new Set(successDetails)];
    if (uniqueSuccess.length > 0) {
      return uniqueSuccess;
    }
    return [PR_ASSISTANT_MESSAGES.recommendations.noSpecific];
  }

  return [...new Set(recommendations)];
}
