import type { CheckResult, PRAnalysisResult } from './types.js';

/**
 * Purpose: Produce a high-level approval summary based on check statuses.
 * Inputs/Outputs: checks object, allPass flag, hasWarnings flag; returns summary string.
 * Edge cases: Defaults to rejection when not all pass and no warnings.
 */
export function generateSummary(checks: PRAnalysisResult['checks'], allPass: boolean, hasWarnings: boolean): string {
  if (allPass) {
    return '✅ **APPROVED** - All checks passed, ready for merge';
  }

  if (hasWarnings) {
    return '⚠️ **CONDITIONAL** - Minor issues found, review recommended';
  }

  return '❌ **REJECTED** - Critical issues detected, fixes required before merge';
}

/**
 * Purpose: Assemble human-readable reasoning for failed/warned checks.
 * Inputs/Outputs: checks object; returns markdown-ready reasoning string.
 * Edge cases: Returns success rationale when no issues are found.
 */
export function generateReasoning(checks: PRAnalysisResult['checks']): string {
  const reasons: string[] = [];

  Object.entries(checks).forEach(([checkName, result]) => {
    if (result.status === '❌') {
      reasons.push(`**${checkName}**: ${result.message}`);
    } else if (result.status === '⚠️') {
      reasons.push(`**${checkName}**: ${result.message} (warning)`);
    }
  });

  if (reasons.length === 0) {
    return 'All validation checks passed successfully. The PR maintains code quality standards and platform compatibility.';
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
    //audit Assumption: checkName is camelCase; risk: unreadable labels; invariant: label is readable; handling: insert spaces.
    const label = checkName.replace(/([a-z])([A-Z])/g, '$1 $2');
    if (result.status !== '✅') {
      recommendations.push(...result.details);
      return;
    }

    const detail = result.details?.[0];
    if (detail) {
      successDetails.push(`✅ ${label}: ${detail}`);
    } else {
      //audit Assumption: success path should still inform; risk: vague success; invariant: message provided; handling: generic success detail.
      successDetails.push(`✅ ${label}: check passed`);
    }
  });

  if (recommendations.length === 0) {
    const uniqueSuccess = [...new Set(successDetails)];
    if (uniqueSuccess.length > 0) {
      return uniqueSuccess;
    }
    return ['No specific recommendations - maintain current code quality standards'];
  }

  return [...new Set(recommendations)];
}
