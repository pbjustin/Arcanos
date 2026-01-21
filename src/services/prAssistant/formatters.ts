import type { CheckResult, PRAnalysisResult } from './types.js';

export function generateSummary(checks: PRAnalysisResult['checks'], allPass: boolean, hasWarnings: boolean): string {
  if (allPass) {
    return '✅ **APPROVED** - All checks passed, ready for merge';
  }

  if (hasWarnings) {
    return '⚠️ **CONDITIONAL** - Minor issues found, review recommended';
  }

  return '❌ **REJECTED** - Critical issues detected, fixes required before merge';
}

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

export function generateRecommendations(checks: Record<string, CheckResult>): string[] {
  const recommendations: string[] = [];

  Object.values(checks).forEach(result => {
    if (result.status !== '✅') {
      recommendations.push(...result.details);
    }
  });

  if (recommendations.length === 0) {
    return ['No specific recommendations - maintain current code quality standards'];
  }

  return [...new Set(recommendations)];
}
