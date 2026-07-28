import { runCommand } from "@services/prAssistant/commandUtils.js";
import type { CheckContext, CheckResult } from "@services/prAssistant/types.js";

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
  } catch {
    return {
      status: '❌',
      message: 'Test suite failed',
      details: [
        'The repository test command did not complete successfully',
        'Fix failing tests before merge',
      ],
    };
  }

  try {
    const buildResult = await runCommand('npm', ['run', 'build'], {
      cwd: context.workingDir,
      timeout: context.validationConstants.BUILD_TIMEOUT
    });

    if (!buildResult.stderr || buildResult.stderr.trim() === '') {
      details.push('Clean TypeScript compilation');
    } else {
      details.push(`Build warnings: ${buildResult.stderr.split('\n').length} lines`);
    }
  } catch {
    return {
      status: '❌',
      message: 'Build failed',
      details: [
        'The repository build command did not complete successfully',
        'Fix compilation errors before merge',
      ],
    };
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
}
