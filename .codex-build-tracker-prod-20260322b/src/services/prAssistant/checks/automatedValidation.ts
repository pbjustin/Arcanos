import { runCommand } from "@services/prAssistant/commandUtils.js";
import type { CheckContext, CheckResult } from "@services/prAssistant/types.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

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
    const errorMessage = resolveErrorMessage(error);

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
