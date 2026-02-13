import fs from 'fs/promises';
import path from 'path';

import { createCheckResult } from "@services/prAssistant/checkResults.js";
import type { CheckContext, CheckResult } from "@services/prAssistant/types.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

export async function checkOpenAICompatibility(
  context: CheckContext,
  diff: string
): Promise<CheckResult> {
  const issues: string[] = [];
  const details: string[] = [];

  try {
    const oldPatterns = [
      { pattern: /openai\.Completion\.create/gi, message: 'Legacy Completion API usage' },
      { pattern: /engine\s*:/gi, message: 'Deprecated engine parameter' },
      { pattern: /max_tokens\s*:/gi, message: 'Consider using max_completion_tokens for GPT-5.1' },
      { pattern: /text-davinci/gi, message: 'Legacy model identifier' },
      { pattern: /text-curie/gi, message: 'Legacy model identifier' },
      { pattern: /davinci/gi, message: 'Legacy model identifier' }
    ];

    for (const { pattern, message } of oldPatterns) {
      if (pattern.test(diff)) {
        issues.push(message);
        details.push('Update to use latest OpenAI SDK v5.15.0+ patterns');
      }
    }

    const openaiCallPattern = /^\+.*(?:openai\.|client\.).*\.(?:create|complete)/gim;
    const openaiCalls = diff.match(openaiCallPattern) || [];

    if (openaiCalls.length > 0) {
      const tryBlockPattern = /try\s*{[\s\S]*?catch/gi;
      const hasTryCatch = tryBlockPattern.test(diff);

      if (!hasTryCatch) {
        issues.push('OpenAI API calls without proper error handling');
        details.push('Wrap OpenAI calls in try-catch blocks');
      }
    }

    const packageJsonPath = path.join(context.workingDir, 'package.json');
    try {
      const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageData = JSON.parse(packageContent);
      const openaiVersion = packageData.dependencies?.openai || packageData.devDependencies?.openai;

      if (openaiVersion) {
        const versionNumber = openaiVersion.replace(/[^\d.]/g, '');
        const [major, minor] = versionNumber.split('.').map(Number);

        if (major < 5 || (major === 5 && minor < 15)) {
          issues.push('Outdated OpenAI SDK version');
          details.push('Update to OpenAI SDK v5.15.0 or later');
        }
      }
    } catch {
      // Package.json might not be accessible, skip this check
    }

    return createCheckResult(
      issues.length,
      'OpenAI SDK compatibility verified',
      `Minor OpenAI compatibility issues: ${issues.length} items`,
      `Significant OpenAI compatibility problems: ${issues.length} issues`,
      3,
      issues.length === 0 ? ['Uses latest OpenAI SDK patterns and best practices'] : details
    );
  } catch (error) {
    return {
      status: '❌',
      message: 'Error checking OpenAI compatibility',
      details: [`Analysis failed: ${resolveErrorMessage(error)}`]
    };
  }
}
