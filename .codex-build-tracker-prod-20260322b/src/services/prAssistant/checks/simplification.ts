import { CHECK_THRESHOLDS, SIMPLIFICATION_PATTERNS } from "@services/prAssistant/analysisRules.js";
import { createCheckResult } from "@services/prAssistant/checkResults.js";
import type { CheckContext, CheckResult } from "@services/prAssistant/types.js";
import { collectMatches, hasLongFunctionAddition, uniqueStrings } from "@services/prAssistant/utils.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

export async function checkSimplification(
  context: CheckContext,
  diff: string
): Promise<CheckResult> {
  const issues: string[] = [];
  const details: string[] = [];

  try {
    const hasComplexFunctions = SIMPLIFICATION_PATTERNS.functionAddition.test(diff);
    const longFunctions = collectMatches(diff, SIMPLIFICATION_PATTERNS.longFunction);

    if (hasComplexFunctions && hasLongFunctionAddition(longFunctions, CHECK_THRESHOLDS.longFunctionLineCount)) {
      issues.push('Large function additions detected');
      details.push('Consider breaking down complex functions into smaller utilities');
    }

    const complexPatterns = collectMatches(diff, SIMPLIFICATION_PATTERNS.complexity);

    if (complexPatterns.length > CHECK_THRESHOLDS.maxComplexityPatterns) {
      issues.push('High cyclomatic complexity detected');
      details.push('Refactor nested logic into separate functions');
    }

    const largeStrings = collectMatches(diff, SIMPLIFICATION_PATTERNS.largeString(context.validationConstants.LARGE_STRING_THRESHOLD));

    if (largeStrings.length > 0) {
      issues.push('Large inline strings detected');
      details.push('Consider moving large strings to configuration files');
    }

    const magicNumbers = collectMatches(diff, SIMPLIFICATION_PATTERNS.magicNumbers);

    if (magicNumbers.length > CHECK_THRESHOLDS.maxMagicNumbers) {
      issues.push('Magic numbers detected');
      details.push('Define constants for numeric literals');
    }

    const detailMessages = issues.length === 0 ? ['Good separation of concerns and readable code structure'] : uniqueStrings(details);

    return createCheckResult(
      issues.length,
      'Code follows simplification best practices',
      `Minor complexity concerns: ${issues.length} areas for improvement`,
      `Significant complexity issues: ${issues.length} problems`,
      3,
      detailMessages
    );
  } catch (error) {
    return {
      status: '❌',
      message: 'Error analyzing code complexity',
      details: [`Analysis failed: ${resolveErrorMessage(error)}`]
    };
  }
}
