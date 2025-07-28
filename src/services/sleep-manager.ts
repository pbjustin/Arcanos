// ARCANOS Sleep Manager Service
// Manages server sleep window and maintenance scheduler
// Sleep Window: 7:00 AM to 2:00 PM Eastern Time daily

import cron from 'node-cron';
import { getCurrentSleepWindowStatus, shouldReduceServerActivity, logSleepWindowStatus } from './sleep-config';
import { modelControlHooks } from './model-control-hooks';
import { workerStatusService } from './worker-status';
import { workerRegistry } from './unified-worker-registry';

export interface SleepManagerConfig {
  enabled: boolean;
  activityReductionEnabled: boolean;
  maintenanceTasksEnabled: boolean;
  logInterval: number; // minutes
}

export class SleepManager {
  private config: SleepManagerConfig;
  private statusLogInterval?: NodeJS.Timeout;
  private maintenanceTasksScheduled: boolean = false;

  constructor(config: Partial<SleepManagerConfig> = {}) {
    this.config = {
      enabled: true,
      activityReductionEnabled: true,
      maintenanceTasksEnabled: true,
      logInterval: 30, // Log status every 30 minutes
      ...config
    };
  }

  /**
   * Initialize the sleep manager
   */
  public async initialize(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[SLEEP-MANAGER] Sleep manager is disabled');
      return;
    }

    console.log('[SLEEP-MANAGER] 🌙 Initializing sleep and maintenance scheduler');
    logSleepWindowStatus();

    // Start periodic status logging
    this.startStatusLogging();

    // Schedule maintenance tasks for sleep window
    if (this.config.maintenanceTasksEnabled) {
      this.scheduleMaintenanceTasks();
    }

    console.log('[SLEEP-MANAGER] ✅ Sleep manager initialized successfully');
  }

  /**
   * Check if server should reduce activity
   */
  public shouldReduceActivity(): boolean {
    return this.config.enabled && this.config.activityReductionEnabled && shouldReduceServerActivity();
  }

  /**
   * Get current sleep window status
   */
  public getSleepStatus() {
    return getCurrentSleepWindowStatus();
  }

  /**
   * Start periodic status logging
   */
  private startStatusLogging(): void {
    if (this.statusLogInterval) {
      clearInterval(this.statusLogInterval);
    }

    this.statusLogInterval = setInterval(() => {
      logSleepWindowStatus();
    }, this.config.logInterval * 60 * 1000);

    // Log immediately
    logSleepWindowStatus();
  }

  /**
   * Schedule maintenance tasks during sleep window
   */
  private scheduleMaintenanceTasks(): void {
    if (this.maintenanceTasksScheduled) {
      return;
    }

    // Memory sync and snapshot - every 2 hours during sleep window
    cron.schedule('0 */2 * * *', async () => {
      if (shouldReduceServerActivity()) {
        await this.executeMaintenanceTask('memory-sync-snapshot', async () => {
          await this.runMemorySyncSnapshot();
        });
      }
    });

    // Goal watcher backlog audit - every hour during sleep window  
    cron.schedule('0 * * * *', async () => {
      if (shouldReduceServerActivity()) {
        await this.executeMaintenanceTask('goal-watcher-audit', async () => {
          await this.runGoalWatcherAudit();
        });
      }
    });

    // Clear temp files and logs - every 3 hours during sleep window
    cron.schedule('0 */3 * * *', async () => {
      if (shouldReduceServerActivity()) {
        await this.executeMaintenanceTask('clear-temp-logs', async () => {
          await this.runClearTempLogs();
        });
      }
    });

    // Daily code improvement suggestions - once at 9 AM ET (during sleep window)
    cron.schedule(
      '0 9 * * *',
      async () => {
        if (shouldReduceServerActivity()) {
          await this.executeMaintenanceTask('code-improvement-suggestions', async () => {
            await this.runCodeImprovementSuggestions();
          });
        }
      },
      { timezone: 'America/New_York' }
    );

    this.maintenanceTasksScheduled = true;
    console.log('[SLEEP-MANAGER] 📅 Maintenance tasks scheduled for sleep window');
  }

  /**
   * Execute a maintenance task with error handling and logging
   */
  private async executeMaintenanceTask(taskName: string, taskFunction: () => Promise<void>): Promise<void> {
    const startTime = Date.now();
    workerStatusService.updateWorkerStatus(`sleep-${taskName}`, 'running', 'sleep_window_maintenance_started');

    try {
      console.log(`[SLEEP-MAINTENANCE] 🔧 Starting ${taskName} during sleep window`);
      await taskFunction();
      const duration = Date.now() - startTime;
      console.log(`[SLEEP-MAINTENANCE] ✅ ${taskName} completed successfully in ${duration}ms`);
      workerStatusService.updateWorkerStatus(`sleep-${taskName}`, 'idle', `sleep_maintenance_complete_${duration}ms`);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`[SLEEP-MAINTENANCE] ❌ ${taskName} failed after ${duration}ms:`, error.message);
      workerStatusService.updateWorkerStatus(`sleep-${taskName}`, 'error', `sleep_maintenance_failed_${error.message}`);
      
      // Fallback: try again in 30 minutes
      setTimeout(async () => {
        console.log(`[SLEEP-MAINTENANCE] 🔄 Retrying ${taskName} (fallback)`);
        try {
          await taskFunction();
          console.log(`[SLEEP-MAINTENANCE] ✅ ${taskName} fallback retry succeeded`);
        } catch (retryError: any) {
          console.error(`[SLEEP-MAINTENANCE] ❌ ${taskName} fallback retry also failed:`, retryError.message);
        }
      }, 30 * 60 * 1000); // 30 minutes
    }
  }

  /**
   * Run memory sync and snapshot task
   */
  private async runMemorySyncSnapshot(): Promise<void> {
    await workerRegistry.dispatchWorker('memorySync');
    
    // Additional snapshot logic
    const result = await modelControlHooks.manageMemory(
      'store',
      {
        key: 'sleep_memory_snapshot',
        value: {
          timestamp: new Date().toISOString(),
          memoryUsage: process.memoryUsage(),
          sleepWindow: true
        },
        tags: ['sleep', 'snapshot', 'maintenance']
      },
      {
        userId: 'system',
        sessionId: 'sleep-maintenance',
        source: 'system'
      }
    );

    if (!result.success) {
      throw new Error(`Memory snapshot failed: ${result.error}`);
    }
  }

  /**
   * Run goal watcher backlog audit
   */
  private async runGoalWatcherAudit(): Promise<void> {
    await workerRegistry.dispatchWorker('goalTracker');

    // Additional backlog audit logic
    const auditResult = await modelControlHooks.performAudit(
      { 
        auditType: 'backlog',
        timestamp: new Date().toISOString(),
        sleepWindow: true 
      },
      'goal_backlog_audit',
      {
        userId: 'system',
        sessionId: 'sleep-maintenance',
        source: 'system'
      }
    );

    if (!auditResult.success) {
      throw new Error(`Goal backlog audit failed: ${auditResult.error}`);
    }
  }

  /**
   * Run clear temp files and logs task
   */
  private async runClearTempLogs(): Promise<void> {
    await workerRegistry.dispatchWorker('cleanupWorker');

    // Additional log cleanup logic
    const cleanupResult = await modelControlHooks.performMaintenance(
      'cleanup',
      { 
        target: 'logs',
        maxAge: '7d',
        sleepWindow: true,
        timestamp: new Date().toISOString()
      },
      {
        userId: 'system',
        sessionId: 'sleep-maintenance',
        source: 'system'
      }
    );

    if (!cleanupResult.success) {
      throw new Error(`Log cleanup failed: ${cleanupResult.error}`);
    }
  }

  /**
   * Run daily code improvement suggestions
   */
  private async runCodeImprovementSuggestions(): Promise<void> {
    await workerRegistry.dispatchWorker('codeImprovement');
  }

  /**
   * Cleanup and stop the sleep manager
   */
  public stop(): void {
    if (this.statusLogInterval) {
      clearInterval(this.statusLogInterval);
      this.statusLogInterval = undefined;
    }
    console.log('[SLEEP-MANAGER] 🛑 Sleep manager stopped');
  }
}

// Export singleton instance
export const sleepManager = new SleepManager();