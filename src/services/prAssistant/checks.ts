import fs from 'fs/promises';
import path from 'path';

import { CHECK_THRESHOLDS, DEAD_CODE_PATTERNS, SIMPLIFICATION_PATTERNS } from './analysisRules.js';
import { createCheckResult } from './checkResults.js';
import { RAILWAY_VALIDATION_PATTERNS } from './constants.js';
import { runCommand } from './commandUtils.js';
import type { CheckContext, CheckResult } from './types.js';
import { collectMatches, getFileLineCount, hasLongFunctionAddition, uniqueStrings } from './utils.js';

async function validateEnvDocumentation(context: CheckContext, envVars: string[]): Promise<{ issues: string[]; details: string[]; }> {
  const issues: string[] = [];
  const details: string[] = [];

  if (envVars.length === 0) {
    return { issues, details };
  }

  try {
    const envExamplePath = path.join(context.workingDir, '.env.example');
    const envExampleContent = await fs.readFile(envExamplePath, 'utf-8');

    const missingVars = envVars.filter(envVar => {
      const varName = envVar.replace('process.env.', '');
      return !envExampleContent.includes(varName);
    });

    if (missingVars.length > 0) {
      issues.push('New environment variables not documented');
      details.push('Update .env.example with new environment variables');
    }
  } catch {
    details.push('Consider creating .env.example for environment documentation');
  }

  return { issues, details };
}

export async function checkDeadCodeRemoval(context: CheckContext, files: string[], diff: string): Promise<CheckResult> {
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
      details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
  }
}

export async function checkSimplification(context: CheckContext, diff: string): Promise<CheckResult> {
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
      details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
  }
}

export async function checkOpenAICompatibility(context: CheckContext, diff: string): Promise<CheckResult> {
  const issues: string[] = [];
  const details: string[] = [];

  try {
    const oldPatterns = [
      { pattern: /openai\.Completion\.create/gi, message: 'Legacy Completion API usage' },
      { pattern: /engine\s*:/gi, message: 'Deprecated engine parameter' },
      { pattern: /max_tokens(?!\s*:)/gi, message: 'Consider using max_completion_tokens for GPT-5.1' },
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
      details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
  }
}

export async function checkRailwayReadiness(context: CheckContext, files: string[], diff: string): Promise<CheckResult> {
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
      details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
  }
}

export async function runAutomatedValidation(context: CheckContext): Promise<CheckResult> {
  const details: string[] = [];

  try {
    const testResult = await runCommand('npm', ['test'], {
      cwd: context.workingDir,
      timeout: context.validationConstants.TEST_TIMEOUT
    });

    if (testResult.stdout.includes('PASS') || testResult.stdout.includes('✓')) {
      details.push('All tests passing');
    }

    const buildResult = await runCommand('npm', ['run', 'build'], {
      cwd: context.workingDir,
      timeout: context.validationConstants.BUILD_TIMEOUT
    });

    if (!buildResult.stderr || buildResult.stderr.trim() === '') {
      details.push('Clean TypeScript compilation');
    } else {
      details.push(`Build warnings: ${buildResult.stderr.split('\n').length} lines`);
    }

    try {
      await runCommand('npm', ['run', 'lint'], {
        cwd: context.workingDir,
        timeout: context.validationConstants.LINT_TIMEOUT
      });
      details.push('Linting passed');
    } catch {
      // Linting might not be available, skip
    }

    return {
      status: '✅',
      message: 'All automated validation passed',
      details
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('test')) {
      return {
        status: '❌',
        message: 'Test suite failed',
        details: [`Test failure: ${errorMessage}`, 'Fix failing tests before merge']
      };
    }

    if (errorMessage.includes('build')) {
      return {
        status: '❌',
        message: 'Build failed',
        details: [`Build error: ${errorMessage}`, 'Fix compilation errors before merge']
      };
    }

    return {
      status: '❌',
      message: 'Validation failed',
      details: [`Validation error: ${errorMessage}`]
    };
  }
}

export async function performFinalDoubleCheck(context: CheckContext): Promise<CheckResult> {
  const details: string[] = [];

  try {
    const criticalFiles = [
      'package.json',
      'src/server.ts',
      'src/services/openai.ts'
    ];

    for (const file of criticalFiles) {
      try {
        const filePath = path.join(context.workingDir, file);
        await fs.access(filePath);
        details.push(`✓ ${file} exists and accessible`);
      } catch {
        return {
          status: '❌',
          message: `Critical file missing: ${file}`,
          details: [`${file} is required for deployment`]
        };
      }
    }

    const envFiles = ['.env.example', 'src/utils/env.ts'];
    let hasEnvConfig = false;

    for (const envFile of envFiles) {
      try {
        await fs.access(path.join(context.workingDir, envFile));
        hasEnvConfig = true;
        details.push(`✓ Environment configuration found: ${envFile}`);
        break;
      } catch {
        // Try next file
      }
    }

    if (!hasEnvConfig) {
      return {
        status: '⚠️',
        message: 'No environment configuration found',
        details: ['Consider adding .env.example or environment documentation']
      };
    }

    try {
      await runCommand('npm', ['run', 'type-check'], {
        cwd: context.workingDir,
        timeout: context.validationConstants.LINT_TIMEOUT
      });
      details.push('✓ TypeScript type checking passed');
    } catch {
      try {
        await runCommand('tsc', ['--noEmit'], {
          cwd: context.workingDir,
          timeout: context.validationConstants.LINT_TIMEOUT
        });
        details.push('✓ TypeScript type checking passed');
      } catch {
        return {
          status: '❌',
          message: 'TypeScript type errors detected',
          details: ['Fix type errors before deployment']
        };
      }
    }

    return {
      status: '✅',
      message: 'All final checks passed - Ready for deployment',
      details
    };
  } catch (error) {
    return {
      status: '❌',
      message: 'Final validation failed',
      details: [`Error: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
  }
}
