import { CHECK_TITLES, REPORT_TEMPLATE } from '../../config/prAssistantTemplates.js';
import { formatCheckLabel } from './utils.js';
import type { CheckResult } from './types.js';

/**
 * Purpose: Standardize check status from issue counts.
 * Inputs/Outputs: issuesCount + messaging + threshold; returns CheckResult.
 * Edge cases: Zero issues returns success details fallback.
 */
export function createCheckResult(
  issuesCount: number,
  successMessage: string,
  warningMessage: string,
  errorMessage: string,
  warningThreshold: number,
  details: string[]
): CheckResult {
  //audit assumption: zero issues means success; failure risk: miscounted issues; expected invariant: issue count derived from matches; handling: explicit check.
  if (issuesCount === 0) {
    return {
      status: '✅',
      message: successMessage,
      details: details.length > 0 ? details : ['No issues detected']
    };
  }

  //audit assumption: small issue count warrants warning; failure risk: threshold misconfigured; expected invariant: warningThreshold > 0; handling: compare and warn.
  if (issuesCount < warningThreshold) {
    return {
      status: '⚠️',
      message: warningMessage,
      details
    };
  }

  //audit assumption: remaining cases are errors; failure risk: ambiguous status; expected invariant: issuesCount >= warningThreshold; handling: return error result.
  return { status: '❌', message: errorMessage, details };
}

/**
 * Purpose: Map a status icon to the report footer message.
 * Inputs/Outputs: status icon; returns message string.
 * Edge cases: Status types are constrained to union.
 */
export function getStatusMessage(status: '✅' | '❌' | '⚠️'): string {
  //audit assumption: status is a known icon; failure risk: missing case; expected invariant: union type; handling: switch mapping.
  switch (status) {
    case '✅':
      return REPORT_TEMPLATE.statusMessages.approved;
    case '⚠️':
      return REPORT_TEMPLATE.statusMessages.conditional;
    case '❌':
      return REPORT_TEMPLATE.statusMessages.rejected;
  }
}

/**
 * Purpose: Render check results into markdown sections.
 * Inputs/Outputs: checks map; returns markdown string.
 * Edge cases: Missing titles fall back to formatted labels.
 */
export function formatChecksMarkdown(checks: Record<string, CheckResult>): string {
  let markdownSection = '';

  Object.entries(checks).forEach(([key, check]) => {
    //audit assumption: check key maps to title; failure risk: undefined title; expected invariant: titles exist; handling: format fallback label.
    const title = CHECK_TITLES[key as keyof typeof CHECK_TITLES] ?? formatCheckLabel(key);
    markdownSection += `### ${check.status} ${title}\n`;
    markdownSection += `${check.message}\n\n`;

    //audit assumption: details are optional; failure risk: noisy output; expected invariant: details only when provided; handling: guard on length.
    if (check.details.length > 0) {
      check.details.forEach(detail => {
        markdownSection += `- ${detail}\n`;
      });
      markdownSection += '\n';
    }
  });

  return markdownSection;
}
