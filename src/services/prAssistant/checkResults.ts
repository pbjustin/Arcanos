import { CHECK_TITLES, REPORT_TEMPLATE } from '../../config/prAssistantTemplates.js';
import type { CheckResult } from './types.js';

export function createCheckResult(
  issuesCount: number,
  successMessage: string,
  warningMessage: string,
  errorMessage: string,
  warningThreshold: number,
  details: string[]
): CheckResult {
  if (issuesCount === 0) {
    return {
      status: '✅',
      message: successMessage,
      details: details.length > 0 ? details : ['No issues detected']
    };
  } else if (issuesCount < warningThreshold) {
    return {
      status: '⚠️',
      message: warningMessage,
      details
    };
  }

  return {
    status: '❌',
    message: errorMessage,
    details
  };
}

export function getStatusMessage(status: '✅' | '❌' | '⚠️'): string {
  switch (status) {
    case '✅':
      return REPORT_TEMPLATE.statusMessages.approved;
    case '⚠️':
      return REPORT_TEMPLATE.statusMessages.conditional;
    case '❌':
      return REPORT_TEMPLATE.statusMessages.rejected;
  }
}

export function formatChecksMarkdown(checks: Record<string, CheckResult>): string {
  let markdownSection = '';

  Object.entries(checks).forEach(([key, check]) => {
    const title = CHECK_TITLES[key as keyof typeof CHECK_TITLES];
    markdownSection += `### ${check.status} ${title}\n`;
    markdownSection += `${check.message}\n\n`;

    if (check.details.length > 0) {
      check.details.forEach(detail => {
        markdownSection += `- ${detail}\n`;
      });
      markdownSection += '\n';
    }
  });

  return markdownSection;
}
