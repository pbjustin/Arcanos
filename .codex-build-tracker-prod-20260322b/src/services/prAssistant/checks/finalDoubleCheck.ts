import fs from 'fs/promises';
import path from 'path';

import { runCommand } from "@services/prAssistant/commandUtils.js";
import type { CheckContext, CheckResult } from "@services/prAssistant/types.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

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
      details: [`Error: ${resolveErrorMessage(error)}`]
    };
  }
}
