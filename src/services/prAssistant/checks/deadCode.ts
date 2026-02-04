import { CHECK_THRESHOLDS, DEAD_CODE_PATTERNS } from '../analysisRules.js';
import { createCheckResult } from '../checkResults.js';
import type { CheckContext, CheckResult } from '../types.js';
import { collectMatches, getFileLineCount, uniqueStrings } from '../utils.js';
import { resolveErrorMessage } from '../../../lib/errors/index.js';

export async function checkDeadCodeRemoval(
  context: CheckContext,
  files: string[],
  diff: string
): Promise<CheckResult> {
  const issues: string[] = [];
  const details: string[] = [];

  try {
    for (const file of files) {
      try {
        const lineCount = await getFileLineCount(context.workingDir, file);

        if (lineCount > context.validationConstants.LARGE_FILE_THRESHOLD) {
          issues.push(`Large file detected: ${file} (${lineCount} lines)`);
          details.push(`Consider breaking down ${file} into smaller, focused modules`);
        }
      } catch {
        // File might be deleted or renamed, skip
      }
    }

    const todoMatches = collectMatches(diff, DEAD_CODE_PATTERNS.todo);
    if (todoMatches && todoMatches.length > 0) {
      issues.push(`${todoMatches.length} TODO/FIXME comments added`);
      details.push('Consider resolving these before merging');
    }

    const debugMatches = collectMatches(diff, DEAD_CODE_PATTERNS.debug);
    if (debugMatches.length > CHECK_THRESHOLDS.maxDebugStatements) {
      issues.push(`${debugMatches.length} console statements added`);
      details.push('Consider using structured logging instead');
    }

    const duplicateMatches = collectMatches(diff, DEAD_CODE_PATTERNS.duplicate);
    if (duplicateMatches.length > 5) {
      issues.push('Potential code duplication detected');
      details.push('Look for opportunities to extract reusable utilities');
    }

    const detailMessages = issues.length === 0 ? ['PR maintains clean codebase standards'] : uniqueStrings(details);

    return createCheckResult(
      issues.length,
      'No bloated or dead code detected',
      `Minor code quality concerns found: ${issues.length} issues`,
      `Significant code quality issues found: ${issues.length} problems`,
      3,
      detailMessages
    );
  } catch (error) {
    return {
      status: '❌',
      message: 'Error analyzing code quality',
      details: [`Analysis failed: ${resolveErrorMessage(error)}`]
    };
  }
}
