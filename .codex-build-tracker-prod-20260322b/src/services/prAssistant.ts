/**
 * ARCANOS PR Assistant Service
 * Focused on codebase integrity and platform alignment
 */

import { getEnvNumber } from "@platform/runtime/env.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { REPORT_TEMPLATE } from "@platform/runtime/prAssistantTemplates.js";
import { formatChecksMarkdown, getStatusMessage } from './prAssistant/checkResults.js';
import { VALIDATION_CONSTANTS } from "./prAssistant/constants.js";
import { checkDeadCodeRemoval, checkOpenAICompatibility, checkRailwayReadiness, checkSimplification, performFinalDoubleCheck, runAutomatedValidation } from './prAssistant/checks.js';
import { generateReasoning, generateRecommendations, generateSummary } from './prAssistant/formatters.js';
import type { CheckContext, PRAnalysisResult, ValidationConfig } from './prAssistant/types.js';
import type { CheckResult } from './prAssistant/types.js';

export class PRAssistant {
  private workingDir: string;
  private validationConstants: ValidationConfig;

  constructor(workingDir: string = process.cwd()) {
    this.workingDir = workingDir;
    this.validationConstants = {
      ...VALIDATION_CONSTANTS,
      DEFAULT_PORT: getEnvNumber('DEFAULT_PORT', VALIDATION_CONSTANTS.DEFAULT_PORT)
    };
  }

  private getContext(): CheckContext {
    return {
      workingDir: this.workingDir,
      validationConstants: this.validationConstants
    };
  }

  /**
   * Expose individual checks for targeted testing and diagnostics
   */
  async checkDeadCodeRemoval(files: string[], diff: string): Promise<CheckResult> {
    const context = this.getContext();
    return checkDeadCodeRemoval(context, files, diff);
  }

  async checkSimplification(diff: string): Promise<CheckResult> {
    const context = this.getContext();
    return checkSimplification(context, diff);
  }

  async checkOpenAICompatibility(files: string[], diff: string): Promise<CheckResult> {
    const context = this.getContext();
    return checkOpenAICompatibility(context, diff);
  }

  async checkRailwayReadiness(files: string[], diff: string): Promise<CheckResult> {
    const context = this.getContext();
    return checkRailwayReadiness(context, files, diff);
  }

  /**
   * Main entry point for PR analysis.
   * Purpose: Evaluate a PR diff and file list against ARCANOS quality checks.
   * Inputs/Outputs: prDiff (unified diff string), prFiles (array of changed paths),
   * returns PRAnalysisResult with status, summary, checks, reasoning, recommendations.
   * Edge cases: Empty diffs still run checks; results rely on check fallbacks.
   */
  async analyzePR(prDiff: string, prFiles: string[]): Promise<PRAnalysisResult> {
    logger.info('ARCANOS PR Assistant - Starting comprehensive analysis', {
      operation: 'analyzePR',
      filesCount: prFiles.length
    });

    const context = this.getContext();

    const checks = {
      deadCodeRemoval: await checkDeadCodeRemoval(context, prFiles, prDiff),
      simplification: await checkSimplification(context, prDiff),
      openaiCompatibility: await checkOpenAICompatibility(context, prDiff),
      railwayReadiness: await checkRailwayReadiness(context, prFiles, prDiff),
      automatedValidation: await runAutomatedValidation(context),
      finalDoubleCheck: await performFinalDoubleCheck(context)
    } as const;

    const allChecksPass = Object.values(checks).every(check => check.status === '✅');
    const hasWarnings = Object.values(checks).some(check => check.status === '⚠️');

    //audit Assumption: check statuses are limited to ✅/⚠️/❌; risk: unknown status; invariant: status derived from checks; handling: map to worst-case.
    const status: '✅' | '❌' | '⚠️' = allChecksPass ? '✅' : (hasWarnings ? '⚠️' : '❌');
    const summary = generateSummary(checks, allChecksPass, hasWarnings);
    const reasoning = generateReasoning(checks);
    const recommendations = generateRecommendations(checks);

    return {
      status,
      summary,
      checks,
      reasoning,
      recommendations
    };
  }

  /**
   * Format the analysis result as markdown
   */
  formatAsMarkdown(result: PRAnalysisResult): string {
    let markdown = `${REPORT_TEMPLATE.header}\n\n`;
    
    markdown += `${REPORT_TEMPLATE.summarySection.replace('{status}', result.status)}\n${result.summary}\n\n`;

    markdown += `${REPORT_TEMPLATE.detailsSection}\n\n`;
    markdown += formatChecksMarkdown(result.checks);

    if (result.reasoning) {
      markdown += `${REPORT_TEMPLATE.reasoningSection}\n\n${result.reasoning}\n\n`;
    }

    if (result.recommendations.length > 0) {
      markdown += `${REPORT_TEMPLATE.recommendationsSection}\n\n`;
      result.recommendations.forEach(rec => {
        markdown += `- ${rec}\n`;
      });
      markdown += '\n';
    }

    // Footer
    const railwayStatus = result.checks.railwayReadiness.status === '✅' ? 'Ready' : 'Needs Review';
    const statusMessage = getStatusMessage(result.status);

    markdown += `${REPORT_TEMPLATE.footer.divider}\n\n`;
    markdown += `${REPORT_TEMPLATE.footer.completedBy}  \n`;
    markdown += `${REPORT_TEMPLATE.footer.sdkVersion}  \n`;
    markdown += `${REPORT_TEMPLATE.footer.railwayStatus.replace('{status}', railwayStatus).replace('{icon}', result.checks.railwayReadiness.status)}  \n`;
    markdown += `${REPORT_TEMPLATE.footer.productionStatus.replace('{statusMessage}', statusMessage)}\n\n`;

    return markdown;
  }
}

export default PRAssistant;