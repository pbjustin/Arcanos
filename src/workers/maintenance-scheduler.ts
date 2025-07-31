/**
 * Maintenance Scheduler Worker - AI-driven system maintenance using OpenAI SDK
 * Handles automated system maintenance, cleanup, and optimization tasks
 */

import { coreAIService } from '../services/ai-service-consolidated';
import type { ChatMessage } from '../services/unified-openai';
import { createServiceLogger } from '../utils/logger';
import { sanitizeJsonString } from '../utils/json';
import fs from 'fs';
import path from 'path';
import * as cron from 'node-cron';
import { z } from 'zod';

const logger = createServiceLogger('MaintenanceScheduler');

export interface MaintenanceTask {
  id: string;
  name: string;
  description: string;
  category: 'cleanup' | 'optimization' | 'monitoring' | 'backup' | 'security';
  priority: 'low' | 'medium' | 'high' | 'critical';
  schedule: string; // cron format
  lastRun?: Date;
  nextRun?: Date;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  estimatedDurationMs: number;
  retryCount: number;
  maxRetries: number;
}

export interface MaintenanceReport {
  taskId: string;
  startTime: Date;
  endTime?: Date;
  status: 'success' | 'failed' | 'partial';
  details: string;
  issuesFound: string[];
  actionsPerformed: string[];
  recommendations: string[];
  nextScheduledRun?: Date;
}

class MaintenanceSchedulerWorker {
  private tasks: Map<string, MaintenanceTask> = new Map();
  private scheduledJobs: Map<string, any> = new Map();
  private logDir: string;
  private isRunning: boolean = false;

  constructor() {
    this.logDir = path.join(process.cwd(), 'storage', 'maintenance-logs');
    this.ensureLogDirectory();
    this.initializeDefaultTasks();
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Initialize default maintenance tasks
   */
  private initializeDefaultTasks(): void {
    const defaultTasks: MaintenanceTask[] = [
      {
        id: 'log-cleanup',
        name: 'Log File Cleanup',
        description: 'Clean up old log files and compress archived logs',
        category: 'cleanup',
        priority: 'medium',
        schedule: '0 2 * * *', // Daily at 2 AM
        status: 'pending',
        estimatedDurationMs: 300000, // 5 minutes
        retryCount: 0,
        maxRetries: 3
      },
      {
        id: 'memory-optimization',
        name: 'Memory Optimization',
        description: 'Analyze memory usage and perform garbage collection if needed',
        category: 'optimization',
        priority: 'high',
        schedule: '0 */6 * * *', // Every 6 hours
        status: 'pending',
        estimatedDurationMs: 120000, // 2 minutes
        retryCount: 0,
        maxRetries: 2
      },
      {
        id: 'database-maintenance',
        name: 'Database Maintenance',
        description: 'Optimize database queries and clean up orphaned records',
        category: 'optimization',
        priority: 'medium',
        schedule: '0 3 * * 0', // Weekly on Sunday at 3 AM
        status: 'pending',
        estimatedDurationMs: 900000, // 15 minutes
        retryCount: 0,
        maxRetries: 3
      },
      {
        id: 'security-scan',
        name: 'Security Health Check',
        description: 'Perform basic security checks and vulnerability assessment',
        category: 'security',
        priority: 'high',
        schedule: '0 1 * * 1', // Weekly on Monday at 1 AM
        status: 'pending',
        estimatedDurationMs: 600000, // 10 minutes
        retryCount: 0,
        maxRetries: 2
      },
      {
        id: 'performance-monitoring',
        name: 'Performance Monitoring',
        description: 'Analyze system performance metrics and generate recommendations',
        category: 'monitoring',
        priority: 'medium',
        schedule: '0 */4 * * *', // Every 4 hours
        status: 'pending',
        estimatedDurationMs: 180000, // 3 minutes
        retryCount: 0,
        maxRetries: 2
      }
    ];

    defaultTasks.forEach(task => {
      this.tasks.set(task.id, task);
    });

    logger.info('Default maintenance tasks initialized', { 
      taskCount: defaultTasks.length 
    });
  }

  /**
   * Execute a maintenance task using AI-driven analysis
   */
  async executeMaintenanceTask(taskId: string): Promise<MaintenanceReport> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Maintenance task not found: ${taskId}`);
    }

    logger.info('Executing maintenance task', { taskId, taskName: task.name });
    
    const startTime = new Date();
    task.status = 'running';
    task.lastRun = startTime;

    const logPath = path.join(this.logDir, `maintenance-${taskId}-${Date.now()}.log`);
    const fileStream = fs.createWriteStream(logPath, { flags: 'a' });

    try {
      // Use AI to analyze and execute the maintenance task
      const analysisResult = await this.performAIMaintenanceAnalysis(task, fileStream);
      
      const endTime = new Date();
      task.status = 'completed';
      task.retryCount = 0;

      const report: MaintenanceReport = {
        taskId,
        startTime,
        endTime,
        status: analysisResult.success ? 'success' : 'partial',
        details: analysisResult.details,
        issuesFound: analysisResult.issuesFound,
        actionsPerformed: analysisResult.actionsPerformed,
        recommendations: analysisResult.recommendations,
        nextScheduledRun: this.calculateNextRun(task.schedule)
      };

      fileStream.end();
      
      logger.success('Maintenance task completed', { 
        taskId, 
        duration: endTime.getTime() - startTime.getTime(),
        status: report.status 
      });

      return report;

    } catch (error: any) {
      const endTime = new Date();
      task.status = 'failed';
      task.retryCount++;

      fileStream.end();
      
      logger.error('Maintenance task failed', error, { 
        taskId,
        retryCount: task.retryCount,
        maxRetries: task.maxRetries
      });

      return {
        taskId,
        startTime,
        endTime,
        status: 'failed',
        details: `Task failed: ${error.message}`,
        issuesFound: [`Execution error: ${error.message}`],
        actionsPerformed: [],
        recommendations: ['Review task configuration', 'Check system resources', 'Retry execution'],
        nextScheduledRun: this.calculateNextRun(task.schedule)
      };
    }
  }

  /**
   * Use AI to analyze system state and perform maintenance
   */
  private async performAIMaintenanceAnalysis(
    task: MaintenanceTask, 
    fileStream: fs.WriteStream
  ): Promise<{
    success: boolean;
    details: string;
    issuesFound: string[];
    actionsPerformed: string[];
    recommendations: string[];
  }> {
    const systemInfo = await this.gatherSystemInformation();
    
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are ARCANOS performing system maintenance analysis. Your task is to:

1. Analyze the provided system information
2. Identify potential issues or optimization opportunities
3. Recommend specific actions to perform
4. Provide maintenance recommendations

Focus on the maintenance category: ${task.category}
Task: ${task.name} - ${task.description}

Respond with structured analysis including:
- Issues identified
- Actions to perform
- Recommendations for future maintenance
- Overall system health assessment`
      },
      {
        role: 'user',
        content: `Perform maintenance analysis for: ${task.name}

Current System Information:
${JSON.stringify(systemInfo, null, 2)}

Please analyze and provide:
1. Issues found
2. Recommended actions
3. Maintenance suggestions
4. System health assessment`
      }
    ];

    let analysisContent = '';
    const result = await coreAIService.completeStream(
      messages,
      `maintenance-${task.category}`,
      (token: string) => {
        process.stdout.write(token);
        fileStream.write(token);
        analysisContent += token;
      },
      {
        maxTokens: 2000,
        temperature: 0.4,
        stream: true
      }
    );

    if (!result.success) {
      throw new Error(`AI maintenance analysis failed: ${result.error}`);
    }

    // Extract structured information from the analysis
    const structuredAnalysis = await this.extractMaintenanceActions(analysisContent);

    // Simulate performing the recommended actions
    const actionsPerformed = await this.performMaintenanceActions(task, structuredAnalysis.actions);

    return {
      success: true,
      details: analysisContent,
      issuesFound: structuredAnalysis.issues,
      actionsPerformed,
      recommendations: structuredAnalysis.recommendations
    };
  }

  /**
   * Gather current system information for analysis
   */
  private async gatherSystemInformation(): Promise<any> {
    const memoryUsage = process.memoryUsage();
    const uptime = process.uptime();
    
    return {
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memoryUsage.external / 1024 / 1024) // MB
      },
      uptime: Math.round(uptime / 3600 * 100) / 100, // hours
      nodeVersion: process.version,
      platform: process.platform,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    };
  }

  /**
   * Extract structured maintenance actions from AI analysis
   */
  private async extractMaintenanceActions(analysisContent: string): Promise<{
    issues: string[];
    actions: string[];
    recommendations: string[];
  }> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'Extract maintenance information from the analysis and return as JSON with keys: issues, actions, recommendations (all arrays of strings).'
      },
      {
        role: 'user',
        content: `Extract structured maintenance data from: ${analysisContent}`
      }
    ];

    const result = await coreAIService.complete(messages, 'extract-maintenance-actions', {
      maxTokens: 500,
      temperature: 0.2
    });

    if (!result.success) {
      return {
        issues: ['Analysis extraction failed'],
        actions: ['Manual review required'],
        recommendations: ['Retry maintenance analysis']
      };
    }

    try {
      const cleaned = sanitizeJsonString(result.content);
      const parsed = JSON.parse(cleaned);
      const schema = z.object({
        issues: z.array(z.string()).optional().default([]),
        actions: z.array(z.string()).optional().default([]),
        recommendations: z.array(z.string()).optional().default([])
      });
      const data = schema.parse(parsed);
      return {
        issues: data.issues,
        actions: data.actions,
        recommendations: data.recommendations
      };
    } catch (error: any) {
      logger.warning('Failed to parse maintenance actions JSON', { content: result.content, error: error.message });
      return {
        issues: ['JSON parsing failed'],
        actions: ['Manual maintenance required'],
        recommendations: ['Review analysis output format']
      };
    }
  }

  /**
   * Perform the recommended maintenance actions
   */
  private async performMaintenanceActions(task: MaintenanceTask, actions: string[]): Promise<string[]> {
    const performedActions: string[] = [];

    for (const action of actions) {
      try {
        // Simulate performing the action based on task category
        switch (task.category) {
          case 'cleanup':
            await this.performCleanupAction(action);
            break;
          case 'optimization':
            await this.performOptimizationAction(action);
            break;
          case 'monitoring':
            await this.performMonitoringAction(action);
            break;
          case 'security':
            await this.performSecurityAction(action);
            break;
          case 'backup':
            await this.performBackupAction(action);
            break;
        }
        
        performedActions.push(action);
        logger.info('Maintenance action performed', { taskId: task.id, action });
        
      } catch (error: any) {
        logger.warning('Maintenance action failed', { taskId: task.id, action, error: error.message });
        performedActions.push(`${action} (failed: ${error.message})`);
      }
    }

    return performedActions;
  }

  // Placeholder maintenance action methods
  private async performCleanupAction(action: string): Promise<void> {
    logger.info('Simulating cleanup action', { action });
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  private async performOptimizationAction(action: string): Promise<void> {
    logger.info('Simulating optimization action', { action });
    if (action.toLowerCase().includes('garbage')) {
      global.gc && global.gc();
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  private async performMonitoringAction(action: string): Promise<void> {
    logger.info('Simulating monitoring action', { action });
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  private async performSecurityAction(action: string): Promise<void> {
    logger.info('Simulating security action', { action });
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  private async performBackupAction(action: string): Promise<void> {
    logger.info('Simulating backup action', { action });
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  /**
   * Calculate next run time based on cron schedule
   */
  private calculateNextRun(cronSchedule: string): Date {
    // Simple next run calculation - in production use a proper cron parser
    const now = new Date();
    const nextRun = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Default to 24 hours from now
    return nextRun;
  }

  /**
   * Schedule all maintenance tasks
   */
  async scheduleAllTasks(): Promise<void> {
    for (const [taskId, task] of this.tasks) {
      try {
        const scheduledTask = cron.schedule(task.schedule, async () => {
          await this.executeMaintenanceTask(taskId);
        });

        this.scheduledJobs.set(taskId, scheduledTask);
        
        logger.info('Maintenance task scheduled', { 
          taskId, 
          schedule: task.schedule,
          nextRun: this.calculateNextRun(task.schedule)
        });
        
      } catch (error: any) {
        logger.error('Failed to schedule maintenance task', error, { taskId });
      }
    }
  }

  /**
   * Start the maintenance scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warning('Maintenance scheduler already running');
      return;
    }

    this.isRunning = true;
    await this.scheduleAllTasks();
    
    logger.success('Maintenance scheduler started', { 
      scheduledTasks: this.scheduledJobs.size 
    });
  }

  /**
   * Stop the maintenance scheduler
   */
  async stop(): Promise<void> {
    for (const [taskId, scheduledTask] of this.scheduledJobs) {
      scheduledTask.stop();
      scheduledTask.destroy();
    }
    
    this.scheduledJobs.clear();
    this.isRunning = false;
    
    logger.info('Maintenance scheduler stopped');
  }

  /**
   * Get maintenance task status
   */
  getTaskStatus(taskId: string): MaintenanceTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all maintenance tasks
   */
  getAllTasks(): MaintenanceTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Check if scheduler is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// Export singleton instance
export const maintenanceSchedulerWorker = new MaintenanceSchedulerWorker();

// Allow running directly from node
if (require.main === module) {
  const [, , taskId] = process.argv;
  
  if (taskId) {
    maintenanceSchedulerWorker.executeMaintenanceTask(taskId).then(report => {
      console.log('Maintenance report:', JSON.stringify(report, null, 2));
    }).catch(err => {
      logger.error('Maintenance execution failed', err);
      process.exit(1);
    });
  } else {
    maintenanceSchedulerWorker.start().catch(err => {
      logger.error('Maintenance scheduler start failed', err);
      process.exit(1);
    });
  }
}