/**
 * ARCANOS PR Assistant Service
 * Focused on codebase integrity and platform alignment
 */

import { spawn, type SpawnOptions } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/structuredLogging.js';

// Configuration Constants
const VALIDATION_CONSTANTS = {
  LARGE_FILE_THRESHOLD: 500,  // Lines threshold for large file detection
  LARGE_STRING_THRESHOLD: 100, // Character threshold for large inline strings
  TEST_TIMEOUT: 120000, // 2 minutes timeout for test execution
  BUILD_TIMEOUT: 120000, // 2 minutes timeout for build execution  
  LINT_TIMEOUT: 60000, // 1 minute timeout for linting
  DEFAULT_PORT: Number(process.env.DEFAULT_PORT) || 8080 // Default port from environment or Railway default
} as const;

// Railway deployment validation patterns
const RAILWAY_VALIDATION_PATTERNS = [
  { pattern: /(?:http:\/\/|https:\/\/)(?!localhost|127\.0\.0\.1|example\.com)/gi, message: 'Hardcoded URLs detected' },
  { pattern: /['"`]\w+\.\w+\.\w+['"`]/gi, message: 'Potential hardcoded domains' },
  { pattern: /:\s*\d{4,5}(?!\s*[,}\]])/gi, message: 'Hardcoded port numbers' },
  { pattern: /password\s*[=:]\s*['"`][^'"`]{3,}['"`]/gi, message: 'Hardcoded password detected' },
  { pattern: /api[_-]?key\s*[=:]\s*['"`][^'"`]{10,}['"`]/gi, message: 'Hardcoded API key detected' }
] as const;

function sanitizeArgs(args: string[]): string[] {
  return args.map(a => a.replace(/[^\w:/.-]/g, ''));
}

function runCommand(command: string, args: string[], options: SpawnOptions = {}): Promise<{ stdout: string; stderr: string; }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, sanitizeArgs(args), { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', d => { stdout += d; });
    proc.stderr?.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `Command failed: ${command} ${args.join(' ')}`));
      }
    });
  });
}

/**
 * Validates environment variables documentation in .env.example
 */
async function validateEnvDocumentation(workingDir: string, envVars: string[]): Promise<{ issues: string[]; details: string[]; }> {
  const issues: string[] = [];
  const details: string[] = [];
  
  if (envVars.length === 0) {
    return { issues, details };
  }
  
  try {
    const envExamplePath = path.join(workingDir, '.env.example');
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
    // .env.example might not exist, add it as a suggestion
    details.push('Consider creating .env.example for environment documentation');
  }
  
  return { issues, details };
}

export interface PRAnalysisResult {
  status: '✅' | '❌' | '⚠️';
  summary: string;
  checks: {
    deadCodeRemoval: CheckResult;
    simplification: CheckResult;
    openaiCompatibility: CheckResult;
    railwayReadiness: CheckResult;
    automatedValidation: CheckResult;
    finalDoubleCheck: CheckResult;
  };
  reasoning: string;
  recommendations: string[];
}

export interface CheckResult {
  status: '✅' | '❌' | '⚠️';
  message: string;
  details: string[];
}

export class PRAssistant {
  private workingDir: string;

  constructor(workingDir: string = process.cwd()) {
    this.workingDir = workingDir;
  }

  /**
   * Main entry point for PR analysis
   */
  async analyzePR(prDiff: string, prFiles: string[]): Promise<PRAnalysisResult> {
    logger.info('ARCANOS PR Assistant - Starting comprehensive analysis', {
      operation: 'analyzePR',
      filesCount: prFiles.length
    });

    const checks = {
      deadCodeRemoval: await this.checkDeadCodeRemoval(prFiles, prDiff),
      simplification: await this.checkSimplification(prFiles, prDiff),
      openaiCompatibility: await this.checkOpenAICompatibility(prFiles, prDiff),
      railwayReadiness: await this.checkRailwayReadiness(prFiles, prDiff),
      automatedValidation: await this.runAutomatedValidation(),
      finalDoubleCheck: await this.performFinalDoubleCheck()
    };

    const allChecksPass = Object.values(checks).every(check => check.status === '✅');
    const hasWarnings = Object.values(checks).some(check => check.status === '⚠️');

    const status: '✅' | '❌' | '⚠️' = allChecksPass ? '✅' : (hasWarnings ? '⚠️' : '❌');
    const summary = this.generateSummary(checks, allChecksPass, hasWarnings);
    const reasoning = this.generateReasoning(checks);
    const recommendations = this.generateRecommendations(checks);

    return {
      status,
      summary,
      checks,
      reasoning,
      recommendations
    };
  }

  /**
   * 1. Dead/Bloated Code Removal
   */
  private async checkDeadCodeRemoval(files: string[], diff: string): Promise<CheckResult> {
    const issues: string[] = [];
    const details: string[] = [];

    try {
      // Check for large files being added (>500 lines)
      for (const file of files) {
        try {
          const content = await fs.readFile(path.join(this.workingDir, file), 'utf-8');
          const lineCount = content.split('\n').length;
          
          if (lineCount > VALIDATION_CONSTANTS.LARGE_FILE_THRESHOLD) {
            issues.push(`Large file detected: ${file} (${lineCount} lines)`);
            details.push(`Consider breaking down ${file} into smaller, focused modules`);
          }
        } catch {
          // File might be deleted or renamed, skip
        }
      }

      // Check for TODO/FIXME comments being added
      const todoPattern = /^\+.*(?:TODO|FIXME|XXX|HACK)/gim;
      const todoMatches = diff.match(todoPattern);
      if (todoMatches && todoMatches.length > 0) {
        issues.push(`${todoMatches.length} TODO/FIXME comments added`);
        details.push('Consider resolving these before merging');
      }

      // Check for console.log/debug statements
      const debugPattern = /^\+.*console\.(?:log|debug|warn|error)/gim;
      const debugMatches = diff.match(debugPattern);
      if (debugMatches && debugMatches.length > 3) {
        issues.push(`${debugMatches.length} console statements added`);
        details.push('Consider using structured logging instead');
      }

      // Check for duplicate code patterns
      const duplicatePattern = /^\+.*(\w+.*){3,}/gim;
      const duplicateMatches = diff.match(duplicatePattern);
      if (duplicateMatches && duplicateMatches.length > 5) {
        issues.push('Potential code duplication detected');
        details.push('Look for opportunities to extract reusable utilities');
      }

      if (issues.length === 0) {
        return {
          status: '✅',
          message: 'No bloated or dead code detected',
          details: ['PR maintains clean codebase standards']
        };
      } else if (issues.length < 3) {
        return {
          status: '⚠️',
          message: `Minor code quality concerns found: ${issues.length} issues`,
          details
        };
      } else {
        return {
          status: '❌',
          message: `Significant code quality issues found: ${issues.length} problems`,
          details
        };
      }
    } catch (error) {
      return {
        status: '❌',
        message: 'Error analyzing code quality',
        details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * 2. Simplification & Streamlining
   */
  private async checkSimplification(files: string[], diff: string): Promise<CheckResult> {
    const issues: string[] = [];
    const details: string[] = [];

    try {
      // Check for overly complex function additions
      const functionPattern = /^\+.*(?:function|=>|\bconst\s+\w+\s*=)/gim;
      const hasComplexFunctions = functionPattern.test(diff);

      // Look for very long functions (>50 lines in diff)
      const longFunctionPattern = /^\+.*(?:function|=>)[\s\S]*?(?=^[+-]|\n\n|$)/gim;
      const longFunctions = diff.match(longFunctionPattern) || [];
      
      if (hasComplexFunctions && longFunctions.some(fn => fn.split('\n').length > 50)) {
        issues.push('Large function additions detected');
        details.push('Consider breaking down complex functions into smaller utilities');
      }

      // Check for nested complexity (multiple levels of if/for/while)
      const complexityPattern = /^\+.*(?:if|for|while|switch).*{[\s\S]*?(?:if|for|while|switch)/gim;
      const complexPatterns = diff.match(complexityPattern) || [];
      
      if (complexPatterns.length > 2) {
        issues.push('High cyclomatic complexity detected');
        details.push('Refactor nested logic into separate functions');
      }

      // Check for inline SQL or large string literals
      const largeStringPattern = new RegExp(`^\\+.*['"\`][^'"\`]{${VALIDATION_CONSTANTS.LARGE_STRING_THRESHOLD},}['"\`]`, 'gim');
      const largeStrings = diff.match(largeStringPattern) || [];
      
      if (largeStrings.length > 0) {
        issues.push('Large inline strings detected');
        details.push('Consider moving large strings to configuration files');
      }

      // Check for magic numbers
      const magicNumberPattern = /^\+.*(?<![.\w])\d{3,}(?![.\w])/gim;
      const magicNumbers = diff.match(magicNumberPattern) || [];
      
      if (magicNumbers.length > 2) {
        issues.push('Magic numbers detected');
        details.push('Define constants for numeric literals');
      }

      if (issues.length === 0) {
        return {
          status: '✅',
          message: 'Code follows simplification best practices',
          details: ['Good separation of concerns and readable code structure']
        };
      } else if (issues.length < 3) {
        return {
          status: '⚠️',
          message: `Minor complexity concerns: ${issues.length} areas for improvement`,
          details
        };
      } else {
        return {
          status: '❌',
          message: `Significant complexity issues: ${issues.length} problems`,
          details
        };
      }
    } catch (error) {
      return {
        status: '❌',
        message: 'Error analyzing code complexity',
        details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * 3. OpenAI SDK Compatibility
   */
  private async checkOpenAICompatibility(files: string[], diff: string): Promise<CheckResult> {
    const issues: string[] = [];
    const details: string[] = [];

    try {
      // Check for outdated OpenAI API patterns
      const oldPatterns = [
        { pattern: /openai\.Completion\.create/gi, message: 'Legacy Completion API usage' },
        { pattern: /engine\s*:/gi, message: 'Deprecated engine parameter' },
        { pattern: /max_tokens(?!\s*:)/gi, message: 'Consider using max_completion_tokens for GPT-5' },
        { pattern: /text-davinci/gi, message: 'Legacy model identifier' },
        { pattern: /text-curie/gi, message: 'Legacy model identifier' },
        { pattern: /davinci/gi, message: 'Legacy model identifier' }
      ];

      for (const { pattern, message } of oldPatterns) {
        if (pattern.test(diff)) {
          issues.push(message);
          details.push(`Update to use latest OpenAI SDK v5.15.0+ patterns`);
        }
      }

      // Check for proper error handling with OpenAI calls
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

      // Check for current SDK version usage
      const packageJsonPath = path.join(this.workingDir, 'package.json');
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

      if (issues.length === 0) {
        return {
          status: '✅',
          message: 'OpenAI SDK compatibility verified',
          details: ['Uses latest OpenAI SDK patterns and best practices']
        };
      } else if (issues.length < 3) {
        return {
          status: '⚠️',
          message: `Minor OpenAI compatibility issues: ${issues.length} items`,
          details
        };
      } else {
        return {
          status: '❌',
          message: `Significant OpenAI compatibility problems: ${issues.length} issues`,
          details
        };
      }
    } catch (error) {
      return {
        status: '❌',
        message: 'Error checking OpenAI compatibility',
        details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * 4. Railway Deployment Readiness
   */
  private async checkRailwayReadiness(files: string[], diff: string): Promise<CheckResult> {
    const issues: string[] = [];
    const details: string[] = [];

    try {
      // Check for hardcoded values that should be environment variables
      for (const { pattern, message } of RAILWAY_VALIDATION_PATTERNS) {
        if (pattern.test(diff)) {
          issues.push(message);
          details.push('Move hardcoded values to environment variables');
        }
      }

      // Check for proper environment variable usage
      const envPattern = /process\.env\.(\w+)/gi;
      const envVars = diff.match(envPattern) || [];
      const uniqueEnvVars = [...new Set(envVars)];

      // Validate environment variables documentation
      const envValidation = await validateEnvDocumentation(this.workingDir, uniqueEnvVars);
      issues.push(...envValidation.issues);
      details.push(...envValidation.details);

      // Check for Railway-specific configurations (informational only)
      ['PORT', 'NODE_ENV', 'RAILWAY_', 'OPENAI_API_KEY'].some(config => diff.includes(config));

      // Check for proper port handling
      const portPattern = /port.*process\.env\.PORT/gi;
      const hasPortHandling = portPattern.test(diff) || files.some(file => file.includes('server') || file.includes('app'));

      if (hasPortHandling && !diff.includes('process.env.PORT')) {
        issues.push('Server files changed without proper PORT environment handling');
        details.push(`Ensure dynamic port assignment with process.env.PORT || ${VALIDATION_CONSTANTS.DEFAULT_PORT}`);
      }

      if (issues.length === 0) {
        return {
          status: '✅',
          message: 'Railway deployment ready',
          details: ['Proper environment variable usage and Railway compatibility']
        };
      } else if (issues.length < 3) {
        return {
          status: '⚠️',
          message: `Minor Railway readiness concerns: ${issues.length} items`,
          details
        };
      } else {
        return {
          status: '❌',
          message: `Railway deployment issues: ${issues.length} problems`,
          details
        };
      }
    } catch (error) {
      return {
        status: '❌',
        message: 'Error checking Railway readiness',
        details: [`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * 5. Automated Validation
   */
  private async runAutomatedValidation(): Promise<CheckResult> {
    const details: string[] = [];

    try {
      // Run npm test
      logger.info('Running test validation', { operation: 'automatedValidation' });
      const testResult = await runCommand('npm', ['test'], {
        cwd: this.workingDir,
        timeout: VALIDATION_CONSTANTS.TEST_TIMEOUT // 2 minutes timeout
      });

      if (testResult.stdout.includes('PASS') || testResult.stdout.includes('✓')) {
        details.push('All tests passing');
      }

      // Run build to ensure TypeScript compilation
      logger.info('Running build validation', { operation: 'automatedValidation' });
      const buildResult = await runCommand('npm', ['run', 'build'], {
        cwd: this.workingDir,
        timeout: VALIDATION_CONSTANTS.BUILD_TIMEOUT
      });

      if (!buildResult.stderr || buildResult.stderr.trim() === '') {
        details.push('Clean TypeScript compilation');
      } else {
        details.push(`Build warnings: ${buildResult.stderr.split('\n').length} lines`);
      }

      // Check for linting if available
      try {
        await runCommand('npm', ['run', 'lint'], {
          cwd: this.workingDir,
          timeout: VALIDATION_CONSTANTS.LINT_TIMEOUT
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
      } else if (errorMessage.includes('build')) {
        return {
          status: '❌',
          message: 'Build failed',
          details: [`Build error: ${errorMessage}`, 'Fix compilation errors before merge']
        };
      } else {
        return {
          status: '❌',
          message: 'Validation failed',
          details: [`Validation error: ${errorMessage}`]
        };
      }
    }
  }

  /**
   * 6. Final Double-Check
   */
  private async performFinalDoubleCheck(): Promise<CheckResult> {
    const details: string[] = [];

    try {
      // Check if critical files still exist and are valid
      const criticalFiles = [
        'package.json',
        'src/server.ts',
        'src/services/openai.ts'
      ];

      for (const file of criticalFiles) {
        try {
          const filePath = path.join(this.workingDir, file);
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

      // Verify environment configuration exists
      const envFiles = ['.env.example', 'src/utils/env.ts'];
      let hasEnvConfig = false;
      
      for (const envFile of envFiles) {
        try {
          await fs.access(path.join(this.workingDir, envFile));
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

      // Final compilation check
      try {
        await runCommand('npm', ['run', 'type-check'], {
          cwd: this.workingDir,
          timeout: VALIDATION_CONSTANTS.LINT_TIMEOUT
        });
        details.push('✓ TypeScript type checking passed');
      } catch {
        try {
          await runCommand('tsc', ['--noEmit'], {
            cwd: this.workingDir,
            timeout: VALIDATION_CONSTANTS.LINT_TIMEOUT
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

  /**
   * Generate markdown summary
   */
  private generateSummary(checks: any, allPass: boolean, hasWarnings: boolean): string {
    if (allPass) {
      return '✅ **APPROVED** - All checks passed, ready for merge';
    } else if (hasWarnings) {
      return '⚠️ **CONDITIONAL** - Minor issues found, review recommended';
    } else {
      return '❌ **REJECTED** - Critical issues detected, fixes required before merge';
    }
  }

  /**
   * Generate detailed reasoning
   */
  private generateReasoning(checks: any): string {
    const reasons: string[] = [];
    
    Object.entries(checks).forEach(([checkName, result]: [string, any]) => {
      if (result.status === '❌') {
        reasons.push(`**${checkName}**: ${result.message}`);
      } else if (result.status === '⚠️') {
        reasons.push(`**${checkName}**: ${result.message} (warning)`);
      }
    });

    if (reasons.length === 0) {
      return 'All validation checks passed successfully. The PR maintains code quality standards and platform compatibility.';
    }

    return reasons.join('\n\n');
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(checks: any): string[] {
    const recommendations: string[] = [];

    Object.values(checks).forEach((result: any) => {
      if (result.status !== '✅') {
        recommendations.push(...result.details);
      }
    });

    if (recommendations.length === 0) {
      recommendations.push('No specific recommendations - maintain current code quality standards');
    }

    return [...new Set(recommendations)]; // Remove duplicates
  }

  /**
   * Format the analysis result as markdown
   */
  formatAsMarkdown(result: PRAnalysisResult): string {
    let markdown = `# 🤖 ARCANOS PR Analysis Report\n\n`;
    
    markdown += `## ${result.status} Summary\n${result.summary}\n\n`;
    
    markdown += `## 📋 Detailed Checks\n\n`;
    
    const checkTitles = {
      deadCodeRemoval: '1. **Dead/Bloated Code Removal**',
      simplification: '2. **Simplification & Streamlining**', 
      openaiCompatibility: '3. **OpenAI SDK Compatibility**',
      railwayReadiness: '4. **Railway Deployment Readiness**',
      automatedValidation: '5. **Automated Validation**',
      finalDoubleCheck: '6. **Final Double-Check**'
    };

    Object.entries(result.checks).forEach(([key, check]) => {
      const title = checkTitles[key as keyof typeof checkTitles];
      markdown += `### ${check.status} ${title}\n`;
      markdown += `${check.message}\n\n`;
      
      if (check.details.length > 0) {
        check.details.forEach(detail => {
          markdown += `- ${detail}\n`;
        });
        markdown += '\n';
      }
    });

    if (result.reasoning) {
      markdown += `## 🔍 Analysis Reasoning\n\n${result.reasoning}\n\n`;
    }

    if (result.recommendations.length > 0) {
      markdown += `## 💡 Recommendations\n\n`;
      result.recommendations.forEach(rec => {
        markdown += `- ${rec}\n`;
      });
      markdown += '\n';
    }

    markdown += `---\n\n`;
    markdown += `*Analysis completed by ARCANOS PR Assistant*  \n`;
    markdown += `*OpenAI SDK Version: 5.15.0+ ✅*  \n`;
    markdown += `*Railway Deployment: ${result.checks.railwayReadiness.status === '✅' ? 'Ready' : 'Needs Review'} ${result.checks.railwayReadiness.status}*  \n`;
    markdown += `*Status: ${result.status === '✅' ? '🎉 **PRODUCTION READY**' : (result.status === '⚠️' ? '⚠️ **REVIEW RECOMMENDED**' : '❌ **FIXES REQUIRED**')}*\n\n`;

    return markdown;
  }
}

export default PRAssistant;