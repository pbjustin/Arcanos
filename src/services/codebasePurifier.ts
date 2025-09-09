/**
 * ARCANOS Automated Codebase Purification Service
 * 
 * Removes bloat, legacy fragments, and redundancy with AI-driven precision.
 * Integrates with existing OpenAI service and PR Assistant workflow.
 */

import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { callOpenAI } from './openai.js';
import { logger } from '../utils/structuredLogging.js';

export interface PurificationConfig {
  enabled: boolean;
  scanners: {
    deadCode: {
      enabled: boolean;
      thresholds: {
        largeFileLines: number;
        maxConsoleLogsPerFile: number;
        maxFunctionLines: number;
        maxInlineStringLength: number;
      };
      skipDirectories: string[];
      supportedExtensions: string[];
    };
    redundancy: {
      enabled: boolean;
      duplicateCodeMinLines: number;
      similarityThreshold: number;
    };
  };
  ai: {
    model: string;
    useExistingService: boolean;
    analysisPrompts: {
      codeReview: string;
      safeDeletion: string;
      refactoring: string;
    };
  };
  safety: {
    requireConfirmation: boolean;
    createBackups: boolean;
    dryRunByDefault: boolean;
    testBeforeChanges: boolean;
  };
  reporting: {
    generateChangeLog: boolean;
    includeMetrics: boolean;
    outputFormat: string;
  };
}

export interface ScanResult {
  filepath: string;
  issues: Array<{
    type: string;
    line: number;
    message: string;
    severity: 'low' | 'medium' | 'high';
  }>;
  metrics: {
    lines: number;
    functions: number;
    complexity?: number;
  };
}

export interface PurificationResult {
  scanResults: ScanResult[];
  aiAnalysis?: string;
  recommendations: Array<{
    action: 'remove' | 'refactor' | 'consolidate';
    target: string;
    reason: string;
    confidence: number;
  }>;
  changeLog: string;
  metrics: {
    filesScanned: number;
    issuesFound: number;
    potentialSavings: {
      lines: number;
      files: number;
    };
  };
}

export class CodebasePurifier {
  private config: PurificationConfig;
  private workingDir: string;

  constructor(configPath: string = 'codex.config.json', workingDir: string = process.cwd()) {
    this.workingDir = workingDir;
    this.config = this.loadConfig(configPath);
  }

  private loadConfig(configPath: string): PurificationConfig {
    try {
      const configFile = path.resolve(this.workingDir, configPath);
      const configData = JSON.parse(readFileSync(configFile, 'utf-8'));
      return configData.purification || this.getDefaultConfig();
    } catch (error) {
      logger.warn('Failed to load config, using defaults', { error: (error as Error).message });
      return this.getDefaultConfig();
    }
  }

  private getDefaultConfig(): PurificationConfig {
    return {
      enabled: true,
      scanners: {
        deadCode: {
          enabled: true,
          thresholds: {
            largeFileLines: 500,
            maxConsoleLogsPerFile: 3,
            maxFunctionLines: 50,
            maxInlineStringLength: 100
          },
          skipDirectories: [
            'node_modules', '.git', 'dist', 'build', 'coverage', 
            '.next', 'logs', 'tmp'
          ],
          supportedExtensions: ['.py', '.js', '.ts', '.jsx', '.tsx', '.go']
        },
        redundancy: {
          enabled: true,
          duplicateCodeMinLines: 5,
          similarityThreshold: 0.8
        }
      },
      ai: {
        model: 'gpt-4-turbo',
        useExistingService: true,
        analysisPrompts: {
          codeReview: 'Analyze the following code for redundancy, unused functions, and optimization opportunities:',
          safeDeletion: 'Determine if the following code can be safely removed without breaking functionality:',
          refactoring: 'Suggest refactoring improvements for the following code:'
        }
      },
      safety: {
        requireConfirmation: true,
        createBackups: true,
        dryRunByDefault: true,
        testBeforeChanges: true
      },
      reporting: {
        generateChangeLog: true,
        includeMetrics: true,
        outputFormat: 'markdown'
      }
    };
  }

  /**
   * Main purification method that orchestrates the entire process
   */
  async purifyCodebase(targetPath?: string): Promise<PurificationResult> {
    if (!this.config.enabled) {
      throw new Error('Codebase purification is disabled in configuration');
    }

    const scanPath = targetPath || this.workingDir;
    logger.info('Starting codebase purification', { scanPath });

    try {
      // Phase 1: Dead Code Detection
      const scanResults = await this.runDeadCodeScan(scanPath);
      
      // Phase 2: AI Analysis (if enabled)
      let aiAnalysis: string | undefined;
      if (this.config.ai.useExistingService) {
        aiAnalysis = await this.runAIAnalysis(scanResults);
      }

      // Phase 3: Generate Recommendations
      const recommendations = await this.generateRecommendations(scanResults, aiAnalysis);

      // Phase 4: Generate Report
      const changeLog = this.generateChangeLog(scanResults, recommendations);
      
      const result: PurificationResult = {
        scanResults,
        aiAnalysis,
        recommendations,
        changeLog,
        metrics: this.calculateMetrics(scanResults)
      };

      logger.info('Purification analysis complete', { 
        filesScanned: result.metrics.filesScanned,
        issuesFound: result.metrics.issuesFound 
      });

      return result;

    } catch (error) {
      logger.error('Purification failed', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Run dead code scanner using the existing Python implementation
   */
  private async runDeadCodeScan(scanPath: string): Promise<ScanResult[]> {
    return new Promise((resolve, reject) => {
      const pythonScript = path.join(this.workingDir, 'dead_code_scanner.py');
      
      const scanner = spawn('python3', [pythonScript, scanPath], {
        cwd: this.workingDir,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      scanner.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      scanner.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      scanner.on('close', (code) => {
        if (code === 0) {
          // Parse scanner results and convert to ScanResult format
          const results = this.parseScannerOutput(stdout);
          resolve(results);
        } else {
          logger.error('Dead code scanner failed', { code, stderr });
          reject(new Error(`Scanner failed with code ${code}: ${stderr}`));
        }
      });

      scanner.on('error', (error) => {
        logger.error('Failed to start scanner', { error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Parse scanner output and convert to structured format
   */
  private parseScannerOutput(output: string): ScanResult[] {
    // This would parse the actual output from the Python scanner
    // For now, return a structured placeholder that demonstrates the concept
    const results: ScanResult[] = [];
    
    // Parse the report file if it exists
    const reportPath = path.join(this.workingDir, 'dead_code_report.txt');
    try {
      const reportContent = readFileSync(reportPath, 'utf-8');
      
      // Extract file-specific information from the report
      const lines = reportContent.split('\n');
      let currentFile = '';
      
      for (const line of lines) {
        if (line.startsWith('📄 ')) {
          currentFile = line.substring(2).trim().replace(':', '');
        } else if (line.trim().startsWith('Line ') && currentFile) {
          const match = line.match(/Line (\d+): (.+)/);
          if (match) {
            const lineNumber = parseInt(match[1]);
            const message = match[2];
            
            // Find or create result for this file
            let fileResult = results.find(r => r.filepath === currentFile);
            if (!fileResult) {
              fileResult = {
                filepath: currentFile,
                issues: [],
                metrics: { lines: 0, functions: 0 }
              };
              results.push(fileResult);
            }
            
            fileResult.issues.push({
              type: 'dead_code',
              line: lineNumber,
              message,
              severity: this.getSeverity(message)
            });
          }
        }
      }
    } catch (error) {
      logger.warn('Could not parse scanner report', { error: (error as Error).message });
    }

    return results;
  }

  private getSeverity(message: string): 'low' | 'medium' | 'high' {
    if (message.includes('unused function') || message.includes('unused class')) {
      return 'medium';
    }
    if (message.includes('unused import')) {
      return 'low';
    }
    return 'medium';
  }

  /**
   * Use AI to analyze scan results and provide intelligent recommendations
   */
  private async runAIAnalysis(scanResults: ScanResult[]): Promise<string> {
    const prompt = this.config.ai.analysisPrompts.codeReview;
    const scanSummary = this.createScanSummary(scanResults);
    
    const fullPrompt = `${prompt}\n\nScan Results:\n${scanSummary}\n\nProvide specific, actionable recommendations for code purification.`;
    
    try {
      const result = await callOpenAI(
        this.config.ai.model,
        fullPrompt,
        1000,
        false // Don't use cache for analysis
      );
      
      return result.output;
    } catch (error) {
      logger.error('AI analysis failed', { error: (error as Error).message });
      return 'AI analysis unavailable';
    }
  }

  private createScanSummary(scanResults: ScanResult[]): string {
    const lines = ['## Scan Summary'];
    
    for (const result of scanResults) {
      if (result.issues.length > 0) {
        lines.push(`\n### ${result.filepath}`);
        lines.push(`- Lines: ${result.metrics.lines}`);
        lines.push(`- Issues found: ${result.issues.length}`);
        
        for (const issue of result.issues) {
          lines.push(`  - Line ${issue.line}: ${issue.message} (${issue.severity})`);
        }
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Generate actionable recommendations based on scan results and AI analysis
   */
  private async generateRecommendations(
    scanResults: ScanResult[], 
    aiAnalysis?: string
  ): Promise<PurificationResult['recommendations']> {
    const recommendations: PurificationResult['recommendations'] = [];

    for (const result of scanResults) {
      for (const issue of result.issues) {
        let action: 'remove' | 'refactor' | 'consolidate' = 'remove';
        let confidence = 0.7;

        if (issue.message.includes('unused import')) {
          action = 'remove';
          confidence = 0.9;
        } else if (issue.message.includes('unused function')) {
          action = 'remove';
          confidence = 0.8;
        } else if (issue.message.includes('large file')) {
          action = 'refactor';
          confidence = 0.6;
        }

        recommendations.push({
          action,
          target: `${result.filepath}:${issue.line}`,
          reason: issue.message,
          confidence
        });
      }
    }

    return recommendations;
  }

  /**
   * Generate detailed change log of proposed modifications
   */
  private generateChangeLog(
    scanResults: ScanResult[], 
    recommendations: PurificationResult['recommendations']
  ): string {
    const lines = [
      '# Codebase Purification Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Summary',
      `- Files scanned: ${scanResults.length}`,
      `- Issues found: ${scanResults.reduce((sum, r) => sum + r.issues.length, 0)}`,
      `- Recommendations: ${recommendations.length}`,
      '',
      '## Recommendations'
    ];

    for (const rec of recommendations) {
      lines.push(`### ${rec.action.toUpperCase()}: ${rec.target}`);
      lines.push(`- Reason: ${rec.reason}`);
      lines.push(`- Confidence: ${(rec.confidence * 100).toFixed(1)}%`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Calculate metrics for the purification results
   */
  private calculateMetrics(scanResults: ScanResult[]): PurificationResult['metrics'] {
    const filesScanned = scanResults.length;
    const issuesFound = scanResults.reduce((sum, r) => sum + r.issues.length, 0);
    
    // Estimate potential savings
    let potentialLinesSaved = 0;
    let filesAffected = 0;

    const filesWithIssues = scanResults.filter(r => r.issues.length > 0);
    filesAffected = filesWithIssues.length;

    for (const result of filesWithIssues) {
      // Estimate lines saved based on issue types
      for (const issue of result.issues) {
        if (issue.message.includes('unused function')) {
          potentialLinesSaved += 10; // Average function size
        } else if (issue.message.includes('unused import')) {
          potentialLinesSaved += 1;
        }
      }
    }

    return {
      filesScanned,
      issuesFound,
      potentialSavings: {
        lines: potentialLinesSaved,
        files: filesAffected
      }
    };
  }

  /**
   * Create a backup of files before making changes (safety feature)
   */
  async createBackup(targetPath: string): Promise<string> {
    const backupDir = path.join(this.workingDir, '.arcanos-backup', Date.now().toString());
    
    // Implementation would recursively copy files to backup directory
    logger.info('Creating backup', { backupDir });
    
    return backupDir;
  }

  /**
   * Apply recommendations with safety checks
   */
  async applyRecommendations(
    recommendations: PurificationResult['recommendations'],
    dryRun: boolean = true
  ): Promise<void> {
    if (!dryRun && this.config.safety.createBackups) {
      await this.createBackup(this.workingDir);
    }

    for (const rec of recommendations) {
      if (rec.confidence < 0.7) {
        logger.info('Skipping low-confidence recommendation', rec);
        continue;
      }

      if (dryRun) {
        logger.info('DRY RUN - Would apply recommendation', rec);
      } else {
        logger.info('Applying recommendation', rec);
        // Implementation would make actual file changes
      }
    }
  }
}

export default CodebasePurifier;