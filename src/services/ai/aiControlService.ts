/**
 * AI Control Service - Backend optimization and AI control elevation
 * Provides functions for codebase optimization, deprecated code removal, and AI access management
 */

import OpenAI from 'openai';
import { promises as fs } from 'fs';
import * as path from 'path';
// Import core AI service with fallback handling
let coreAIService: any = null;

try {
  const coreAIModule = require('./core-ai-service');
  coreAIService = coreAIModule.coreAIService;
} catch (error: any) {
  console.warn('⚠️ Core AI Service not available, using mock implementation:', error.message);
  // Mock implementation for testing
  coreAIService = {
    complete: async () => ({
      success: false,
      content: 'AI service not available',
      model: 'mock',
      error: 'OpenAI API not configured'
    })
  };
}
import { createServiceLogger } from '../../utils/logger';

const logger = createServiceLogger('AIControlService');

export interface OptimizeCodebaseOptions {
  engine: string;
  directories: string[];
  constraints: {
    preserveTests: boolean;
    refactorStyle: 'modular-functional' | 'object-oriented' | 'hybrid';
  };
}

export interface RemoveDeprecatedOptions {
  targetPaths: string[];
  strategy: 'conservative' | 'aggressive' | 'destructive';
}

export interface GrantAIAccessOptions {
  permissions: ('memory' | 'dispatch' | 'scheduler' | 'logic')[];
  tokenScope: string;
  persistent: boolean;
}

export interface OptimizationResult {
  success: boolean;
  filesProcessed: number;
  optimizationsApplied: string[];
  errors?: string[];
  timeTaken: number;
}

export interface DeprecatedRemovalResult {
  success: boolean;
  filesRemoved: number;
  linesRemoved: number;
  deprecatedPatterns: string[];
  errors?: string[];
}

export interface AIAccessResult {
  success: boolean;
  permissionsGranted: string[];
  tokenScope: string;
  accessLevel: 'full' | 'partial' | 'denied';
  timestamp: string;
}

class AIControlService {
  private permissionsRegistry: Map<string, string[]> = new Map();
  private accessTokens: Map<string, any> = new Map();

  /**
   * Optimize codebase using AI-driven analysis and refactoring
   */
  async optimizeCodebase(options: OptimizeCodebaseOptions): Promise<OptimizationResult> {
    const startTime = Date.now();
    logger.info('Starting codebase optimization', options);

    try {
      const result: OptimizationResult = {
        success: true,
        filesProcessed: 0,
        optimizationsApplied: [],
        timeTaken: 0
      };

      for (const directory of options.directories) {
        const files = await this.getCodeFiles(directory);
        
        for (const file of files) {
          try {
            const optimized = await this.optimizeFile(file, options);
            if (optimized) {
              result.filesProcessed++;
              result.optimizationsApplied.push(`Optimized ${file}`);
            }
          } catch (error: any) {
            logger.error(`Failed to optimize ${file}`, error);
            result.errors = result.errors || [];
            result.errors.push(`${file}: ${error.message}`);
          }
        }
      }

      result.timeTaken = Date.now() - startTime;
      logger.info('Codebase optimization completed', result);
      return result;

    } catch (error: any) {
      logger.error('Codebase optimization failed', error);
      return {
        success: false,
        filesProcessed: 0,
        optimizationsApplied: [],
        errors: [error.message],
        timeTaken: Date.now() - startTime
      };
    }
  }

  /**
   * Remove deprecated code patterns from specified paths
   */
  async removeDeprecated(options: RemoveDeprecatedOptions): Promise<DeprecatedRemovalResult> {
    logger.info('Starting deprecated code removal', options);

    try {
      const result: DeprecatedRemovalResult = {
        success: true,
        filesRemoved: 0,
        linesRemoved: 0,
        deprecatedPatterns: []
      };

      const deprecatedPatterns = this.getDeprecatedPatterns(options.strategy);
      result.deprecatedPatterns = deprecatedPatterns;

      for (const targetPath of options.targetPaths) {
        const pathResult = await this.removeDeprecatedFromPath(targetPath, deprecatedPatterns, options.strategy);
        result.filesRemoved += pathResult.filesRemoved;
        result.linesRemoved += pathResult.linesRemoved;
      }

      logger.info('Deprecated code removal completed', result);
      return result;

    } catch (error: any) {
      logger.error('Deprecated code removal failed', error);
      return {
        success: false,
        filesRemoved: 0,
        linesRemoved: 0,
        deprecatedPatterns: [],
        errors: [error.message]
      };
    }
  }

  /**
   * Grant AI access to system components
   */
  async grantAIAccess(options: GrantAIAccessOptions): Promise<AIAccessResult> {
    logger.info('Granting AI access', options);

    try {
      const timestamp = new Date().toISOString();
      const accessToken = this.generateAccessToken(options.tokenScope);

      // Register permissions
      this.permissionsRegistry.set(options.tokenScope, options.permissions);
      this.accessTokens.set(options.tokenScope, {
        permissions: options.permissions,
        persistent: options.persistent,
        createdAt: timestamp,
        token: accessToken
      });

      // Log access grant
      await this.logAccessGrant(options, timestamp);

      const result: AIAccessResult = {
        success: true,
        permissionsGranted: options.permissions,
        tokenScope: options.tokenScope,
        accessLevel: options.permissions.length === 4 ? 'full' : 'partial',
        timestamp
      };

      logger.info('AI access granted successfully', result);
      return result;

    } catch (error: any) {
      logger.error('Failed to grant AI access', error);
      return {
        success: false,
        permissionsGranted: [],
        tokenScope: options.tokenScope,
        accessLevel: 'denied',
        timestamp: new Date().toISOString()
      };
    }
  }

  private async getCodeFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    const extensions = ['.ts', '.js', '.json'];

    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subFiles = await this.getCodeFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      logger.warning(`Could not read directory ${directory}`, error);
    }

    return files;
  }

  private async optimizeFile(filePath: string, options: OptimizeCodebaseOptions): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Skip very large files or binary files
      if (content.length > 50000 || content.includes('\0')) {
        return false;
      }

      const messages = [
        {
          role: 'system' as const,
          content: `You are a code optimization expert. Optimize the following code using ${options.constraints.refactorStyle} style. Preserve tests: ${options.constraints.preserveTests}. Return only the optimized code without explanations.`
        },
        {
          role: 'user' as const,
          content: `Optimize this code:\n\n${content}`
        }
      ];

      const aiResponse = await coreAIService.complete(
        messages,
        'code-optimization',
        { model: options.engine, maxTokens: 2000, temperature: 0.1 }
      );

      if (aiResponse.success && aiResponse.content.trim() !== content.trim()) {
        // Apply basic validation before writing
        if (this.isValidOptimization(content, aiResponse.content)) {
          await fs.writeFile(filePath, aiResponse.content);
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error(`Failed to optimize file ${filePath}`, error);
      return false;
    }
  }

  private getDeprecatedPatterns(strategy: string): string[] {
    const basePatterns = [
      'console.log',
      'TODO:',
      'FIXME:',
      'DEPRECATED:',
      'var ',
      '== ',
      '!= '
    ];

    const aggressivePatterns = [
      'function(',
      'require(',
      'module.exports',
      'process.exit',
      'eval(',
      'new Function'
    ];

    const destructivePatterns = [
      'setTimeout',
      'setInterval',
      'Promise.all',
      'async function',
      'await '
    ];

    switch (strategy) {
      case 'aggressive':
        return [...basePatterns, ...aggressivePatterns];
      case 'destructive':
        return [...basePatterns, ...aggressivePatterns, ...destructivePatterns];
      default:
        return basePatterns;
    }
  }

  private async removeDeprecatedFromPath(
    targetPath: string, 
    patterns: string[], 
    strategy: string
  ): Promise<{ filesRemoved: number; linesRemoved: number }> {
    let filesRemoved = 0;
    let linesRemoved = 0;

    try {
      const stats = await fs.stat(targetPath);
      
      if (stats.isDirectory()) {
        const files = await this.getCodeFiles(targetPath);
        
        for (const file of files) {
          const result = await this.removeDeprecatedFromFile(file, patterns);
          if (result.removed) filesRemoved++;
          linesRemoved += result.linesRemoved;
        }
      } else if (stats.isFile()) {
        const result = await this.removeDeprecatedFromFile(targetPath, patterns);
        if (result.removed) filesRemoved++;
        linesRemoved += result.linesRemoved;
      }
    } catch (error) {
      logger.warning(`Could not process path ${targetPath}`, error);
    }

    return { filesRemoved, linesRemoved };
  }

  private async removeDeprecatedFromFile(
    filePath: string, 
    patterns: string[]
  ): Promise<{ removed: boolean; linesRemoved: number }> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const originalLineCount = lines.length;
      
      const filteredLines = lines.filter(line => {
        return !patterns.some(pattern => line.includes(pattern));
      });

      const linesRemoved = originalLineCount - filteredLines.length;
      
      if (linesRemoved > 0) {
        await fs.writeFile(filePath, filteredLines.join('\n'));
        return { removed: true, linesRemoved };
      }

      return { removed: false, linesRemoved: 0 };
    } catch (error) {
      logger.error(`Failed to remove deprecated code from ${filePath}`, error);
      return { removed: false, linesRemoved: 0 };
    }
  }

  private generateAccessToken(scope: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${scope}_${timestamp}_${random}`;
  }

  private async logAccessGrant(options: GrantAIAccessOptions, timestamp: string): Promise<void> {
    const logEntry = {
      timestamp,
      action: 'AI_ACCESS_GRANTED',
      permissions: options.permissions,
      tokenScope: options.tokenScope,
      persistent: options.persistent
    };

    logger.info('AI access granted', logEntry);
    
    // You could also write to a dedicated access log file here
    // await fs.appendFile('logs/ai-access.log', JSON.stringify(logEntry) + '\n');
  }

  private isValidOptimization(original: string, optimized: string): boolean {
    // Basic validation to ensure optimization didn't break structure
    const originalBraces = (original.match(/[{}]/g) || []).length;
    const optimizedBraces = (optimized.match(/[{}]/g) || []).length;
    
    // Allow some variance but not complete removal of structure
    return Math.abs(originalBraces - optimizedBraces) <= originalBraces * 0.3;
  }

  /**
   * Check if AI has access to specific permissions
   */
  hasAccess(tokenScope: string, permission: string): boolean {
    const permissions = this.permissionsRegistry.get(tokenScope);
    return permissions ? permissions.includes(permission) : false;
  }

  /**
   * Get current AI access status
   */
  getAccessStatus(tokenScope: string): any {
    return this.accessTokens.get(tokenScope) || null;
  }
}

// Export singleton instance and individual functions
export const aiControlService = new AIControlService();

export const optimizeCodebase = (options: OptimizeCodebaseOptions) => 
  aiControlService.optimizeCodebase(options);

export const removeDeprecated = (options: RemoveDeprecatedOptions) => 
  aiControlService.removeDeprecated(options);

export const grantAIAccess = (options: GrantAIAccessOptions) => 
  aiControlService.grantAIAccess(options);