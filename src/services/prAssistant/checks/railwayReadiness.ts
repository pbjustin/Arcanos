import { createCheckResult } from "@services/prAssistant/checkResults.js";
import { RAILWAY_VALIDATION_PATTERNS } from "@services/prAssistant/constants.js";
import type { CheckContext, CheckResult } from "@services/prAssistant/types.js";
import { collectMatches, uniqueStrings } from "@services/prAssistant/utils.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { validateEnvDocumentation } from './envDocumentation.js';

export async function checkRailwayReadiness(
  context: CheckContext,
  files: string[],
  diff: string
): Promise<CheckResult> {
  const issues: string[] = [];
  const details: string[] = [];

  try {
    for (const { pattern, message } of RAILWAY_VALIDATION_PATTERNS) {
      if (pattern.test(diff)) {
        issues.push(message);
        details.push('Move hardcoded values to environment variables');
      }
    }

    const envPattern = /process\.env\.(\w+)/gi;
    const envVars = collectMatches(diff, envPattern);
    const uniqueEnvVars = uniqueStrings(envVars);

    const envValidation = await validateEnvDocumentation(context, uniqueEnvVars);
    issues.push(...envValidation.issues);
    details.push(...envValidation.details);

    ['PORT', 'NODE_ENV', 'RAILWAY_', 'OPENAI_API_KEY'].some(config => diff.includes(config));

    const portPattern = /port.*process\.env\.PORT/gi;
    const hasPortHandling = portPattern.test(diff) || files.some(file => file.includes('server') || file.includes('app'));

    if (hasPortHandling && !diff.includes('process.env.PORT')) {
      issues.push('Server files changed without proper PORT environment handling');
      details.push(`Ensure dynamic port assignment with process.env.PORT || ${context.validationConstants.DEFAULT_PORT}`);
    }

    const detailMessages = issues.length === 0 ? ['Proper environment variable usage and Railway compatibility'] : uniqueStrings(details);

    return createCheckResult(
      issues.length,
      'Railway deployment ready',
      `Minor Railway readiness concerns: ${issues.length} items`,
      `Railway deployment issues: ${issues.length} problems`,
      3,
      detailMessages
    );
  } catch (error) {
    return {
      status: '❌',
      message: 'Error checking Railway readiness',
      details: [`Analysis failed: ${resolveErrorMessage(error)}`]
    };
  }
}
