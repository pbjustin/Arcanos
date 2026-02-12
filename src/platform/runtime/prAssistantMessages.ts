/**
 * PR Assistant Messaging
 * Centralized long-form strings for summaries and recommendations.
 */

export const PR_ASSISTANT_MESSAGES = {
  summary: {
    approved: '✅ **APPROVED** - All checks passed, ready for merge',
    conditional: '⚠️ **CONDITIONAL** - Minor issues found, review recommended',
    rejected: '❌ **REJECTED** - Critical issues detected, fixes required before merge'
  },
  reasoning: {
    noIssues:
      'All validation checks passed successfully. The PR maintains code quality standards and platform compatibility.'
  },
  recommendations: {
    noSpecific: 'No specific recommendations - maintain current code quality standards',
    successFallback: '✅ {label}: check passed'
  }
} as const;
