import { createCheckResult } from "@services/prAssistant/checkResults.js";
import { RAILWAY_VALIDATION_PATTERNS } from "@services/prAssistant/constants.js";
import type { CheckContext, CheckResult } from "@services/prAssistant/types.js";
import { collectMatches, uniqueStrings } from "@services/prAssistant/utils.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { validateEnvDocumentation } from './envDocumentation.js';

function normalizeDiffPath(rawPath: string): string {
  return rawPath.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function shouldScanRailwayDiffPath(filePath: string | null): boolean {
  if (!filePath) {
    return true;
  }

  const normalizedPath = normalizeDiffPath(filePath);

  if (
    normalizedPath.endsWith('package-lock.json') ||
    normalizedPath.endsWith('npm-shrinkwrap.json') ||
    normalizedPath.endsWith('pnpm-lock.yaml') ||
    normalizedPath.endsWith('yarn.lock') ||
    normalizedPath.endsWith('.env.example') ||
    normalizedPath.endsWith('.env.sample') ||
    normalizedPath.endsWith('.md') ||
    normalizedPath.startsWith('tests/') ||
    normalizedPath.includes('/tests/')
  ) {
    return false;
  }

  return true;
}

function collectRelevantDiffLines(diff: string, marker: '+' | '-'): string[] {
  const relevantLines: string[] = [];
  let currentFilePath: string | null = null;

  for (const line of diff.split(/\r?\n/u)) {
    const diffHeaderMatch = /^diff --git a\/.* b\/(.+)$/.exec(line);
    if (diffHeaderMatch) {
      currentFilePath = diffHeaderMatch[1];
      continue;
    }

    if (
      line.startsWith(marker) &&
      !line.startsWith(`${marker}${marker}${marker}`) &&
      shouldScanRailwayDiffPath(currentFilePath)
    ) {
      relevantLines.push(line.slice(1));
    }
  }

  return relevantLines;
}

export async function checkRailwayReadiness(
  context: CheckContext,
  files: string[],
  diff: string
): Promise<CheckResult> {
  const issues: string[] = [];
  const details: string[] = [];

  try {
    const addedRailwayRelevantDiff = collectRelevantDiffLines(diff, '+').join('\n');
    const removedRailwayRelevantDiff = collectRelevantDiffLines(diff, '-').join('\n');

    for (const { pattern, message } of RAILWAY_VALIDATION_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(addedRailwayRelevantDiff)) {
        issues.push(message);
        details.push('Move hardcoded values to environment variables');
      }
    }

    const envPattern = /process\.env\.(\w+)/gi;
    const addedEnvVars = collectMatches(addedRailwayRelevantDiff, envPattern);
    const removedEnvVars = new Set(collectMatches(removedRailwayRelevantDiff, envPattern));
    const uniqueEnvVars = uniqueStrings(addedEnvVars).filter((envVar) => !removedEnvVars.has(envVar));

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
