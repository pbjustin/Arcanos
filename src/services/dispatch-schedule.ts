/**
 * Schedule Dispatch Module
 * Centralized schedule management with error boundaries
 */

import * as cron from 'node-cron';
import { createServiceLogger } from '../utils/logger';
import { workerRegistry } from './unified-worker-registry';
import { SCHEDULE_CONSTANTS, ScheduleConfig, isValidCronExpression } from '../config/scheduler';

const logger = createServiceLogger('DispatchSchedule');

export interface ScheduledTask {
  id: string;
  config: ScheduleConfig;
  cronTask: cron.ScheduledTask;
  isRunning: boolean;
  lastRun?: Date;
  nextRun?: Date;
  errorCount: number;
}

class ScheduleDispatcher {
  private scheduledTasks: Map<string, ScheduledTask> = new Map();
  private errorBoundaries: Map<string, number> = new Map();

  /**
   * Error boundary wrapper for schedule triggers
   */
  private createErrorBoundary(taskId: string, handler: () => Promise<void>): () => Promise<void> {
    return async () => {
      const task = this.scheduledTasks.get(taskId);
      if (!task) {
        logger.error('Task not found in error boundary', { taskId });
        return;
      }

      try {
        task.isRunning = true;
        task.lastRun = new Date();
        
        logger.info('Schedule trigger executing', { 
          taskId, 
          workerType: task.config.workerType,
          lastRun: task.lastRun 
        });

        await handler();
        
        // Reset error count on successful execution
        task.errorCount = 0;
        this.errorBoundaries.set(taskId, 0);
        
        logger.success('Schedule trigger completed', { taskId });

      } catch (error: any) {
        task.errorCount++;
        const totalErrors = this.errorBoundaries.get(taskId) || 0;
        this.errorBoundaries.set(taskId, totalErrors + 1);

        logger.error('Schedule trigger failed', error, { 
          taskId,
          errorCount: task.errorCount,
          totalErrors: totalErrors + 1,
          maxRetries: task.config.maxRetries
        });

        // Disable task if error count exceeds maximum
        if (task.errorCount >= task.config.maxRetries) {
          logger.warning('Disabling task due to excessive errors', { 
            taskId, 
            errorCount: task.errorCount 
          });
          this.stopSchedule(taskId);
        }

      } finally {
        task.isRunning = false;
      }
    };
  }

  /**
   * Start a scheduled task
   */
  startSchedule(config: ScheduleConfig): boolean {
    if (!isValidCronExpression(config.cronExpression)) {
      logger.error('Invalid cron expression', { 
        taskId: config.id, 
        cron: config.cronExpression 
      });
      return false;
    }

    if (this.scheduledTasks.has(config.id)) {
      logger.warning('Schedule already exists', { taskId: config.id });
      return false;
    }

    if (!config.enabled) {
      logger.info('Schedule is disabled, skipping', { taskId: config.id });
      return false;
    }

    // Verify worker exists
    const workerHandler = workerRegistry.getWorkerHandler(config.workerType);
    if (!workerHandler) {
      logger.error('Worker not found for schedule', { 
        taskId: config.id, 
        workerType: config.workerType 
      });
      return false;
    }

    try {
      const handler = async () => {
        const result = await workerRegistry.dispatchWorker(config.workerType);
        if (!result.success) {
          throw new Error(result.error || 'Worker dispatch failed');
        }
      };

      const cronTask = cron.schedule(
        config.cronExpression,
        this.createErrorBoundary(config.id, handler),
        {
          timezone: config.timezone
        }
      );

      const scheduledTask: ScheduledTask = {
        id: config.id,
        config,
        cronTask,
        isRunning: false,
        errorCount: 0
      };

      this.scheduledTasks.set(config.id, scheduledTask);
      this.errorBoundaries.set(config.id, 0);

      logger.info('Schedule started successfully', { 
        taskId: config.id,
        workerType: config.workerType,
        cron: config.cronExpression,
        timezone: config.timezone
      });

      return true;

    } catch (error: any) {
      logger.error('Failed to start schedule', error, { taskId: config.id });
      return false;
    }
  }

  /**
   * Stop a scheduled task
   */
  stopSchedule(taskId: string): boolean {
    const task = this.scheduledTasks.get(taskId);
    if (!task) {
      logger.warning('Cannot stop non-existent schedule', { taskId });
      return false;
    }

    try {
      task.cronTask.stop();
      task.cronTask.destroy();
      this.scheduledTasks.delete(taskId);
      this.errorBoundaries.delete(taskId);

      logger.info('Schedule stopped successfully', { taskId });
      return true;

    } catch (error: any) {
      logger.error('Failed to stop schedule', error, { taskId });
      return false;
    }
  }

  /**
   * Get schedule status
   */
  getScheduleStatus(taskId: string): ScheduledTask | undefined {
    return this.scheduledTasks.get(taskId);
  }

  /**
   * Get all scheduled tasks
   */
  getAllSchedules(): ScheduledTask[] {
    return Array.from(this.scheduledTasks.values());
  }

  /**
   * Get running schedules
   */
  getRunningSchedules(): ScheduledTask[] {
    return Array.from(this.scheduledTasks.values()).filter(task => task.isRunning);
  }

  /**
   * Get schedule statistics
   */
  getStats(): {
    totalSchedules: number;
    runningSchedules: number;
    erroredSchedules: number;
    totalErrors: number;
  } {
    const tasks = Array.from(this.scheduledTasks.values());
    const totalSchedules = tasks.length;
    const runningSchedules = tasks.filter(task => task.isRunning).length;
    const erroredSchedules = tasks.filter(task => task.errorCount > 0).length;
    const totalErrors = Array.from(this.errorBoundaries.values()).reduce((sum, count) => sum + count, 0);

    return {
      totalSchedules,
      runningSchedules,
      erroredSchedules,
      totalErrors
    };
  }

  /**
   * Restart a schedule (stop and start)
   */
  restartSchedule(taskId: string): boolean {
    const task = this.scheduledTasks.get(taskId);
    if (!task) {
      logger.warning('Cannot restart non-existent schedule', { taskId });
      return false;
    }

    const config = task.config;
    const stopped = this.stopSchedule(taskId);
    if (!stopped) {
      return false;
    }

    return this.startSchedule(config);
  }

  /**
   * Update schedule configuration
   */
  updateSchedule(taskId: string, newConfig: Partial<ScheduleConfig>): boolean {
    const task = this.scheduledTasks.get(taskId);
    if (!task) {
      logger.warning('Cannot update non-existent schedule', { taskId });
      return false;
    }

    const updatedConfig = { ...task.config, ...newConfig };
    return this.restartSchedule(taskId);
  }
}

// Create and export singleton instance
export const scheduleDispatcher = new ScheduleDispatcher();

// Convenience functions
export function startSchedule(config: ScheduleConfig): boolean {
  return scheduleDispatcher.startSchedule(config);
}

export function stopSchedule(taskId: string): boolean {
  return scheduleDispatcher.stopSchedule(taskId);
}

export function getScheduleStatus(taskId: string): ScheduledTask | undefined {
  return scheduleDispatcher.getScheduleStatus(taskId);
}