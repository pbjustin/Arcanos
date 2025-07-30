// AI Reflection Scheduler + Long-Term Memory (OpenAI SDK Compliant)
// Summary: Triggers self-reflection every 40 minutes, stores results persistently, and prunes snapshots older than 7 days

import { reflect } from './services/ai';
import { writeToRepo } from './utils/git';
import { pruneOldReflections } from './utils/cleanup';
import { createServiceLogger } from './utils/logger';

const logger = createServiceLogger('AIReflectionScheduler');

export class AIReflectionScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor() {
    logger.info('AI Reflection Scheduler initialized');
  }

  /**
   * Start the reflection scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warning('Scheduler already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting AI reflection scheduler (40-minute intervals)');

    // Start the main reflection interval
    this.intervalId = setInterval(async () => {
      await this.runReflectionCycle();
    }, 40 * 60 * 1000); // every 40 minutes

    // Run initial reflection cycle
    this.runReflectionCycle().catch(error => {
      logger.error('Initial reflection cycle failed', error);
    });
  }

  /**
   * Stop the reflection scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('AI reflection scheduler stopped');
  }

  /**
   * Run a single reflection cycle
   */
  private async runReflectionCycle(): Promise<void> {
    try {
      logger.info('Starting reflection cycle');

      // Step 1: Perform AI reflection
      const snapshot = await reflect({
        label: `auto_reflection_${Date.now()}`,
        persist: true,
        includeStack: true,
        commitIfChanged: true,
        targetPath: 'ai_outputs/reflections/'
      });

      logger.info('Reflection completed', { 
        label: snapshot.label,
        timestamp: snapshot.timestamp 
      });

      // Step 2: Write to repository
      await writeToRepo(snapshot, {
        path: 'ai_outputs/reflections/',
        commitMessage: `🧠 Reflection Update - ${new Date().toISOString()}`
      });

      logger.info('Reflection written to repository');

      // Step 3: Prune old reflections
      const pruneResult = await pruneOldReflections({
        directory: 'ai_outputs/reflections/',
        olderThanDays: 7
      });

      logger.info('Old reflections pruned', {
        totalFound: pruneResult.totalFound,
        pruned: pruneResult.pruned,
        errors: pruneResult.errors.length
      });

      if (pruneResult.errors.length > 0) {
        logger.warning('Pruning errors occurred', { errors: pruneResult.errors });
      }

    } catch (error: any) {
      logger.error('Reflection cycle failed', error, {
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): { isRunning: boolean; nextRunIn?: number } {
    return {
      isRunning: this.isRunning,
      // Approximate time to next run (not exact due to setInterval behavior)
      nextRunIn: this.isRunning ? 40 * 60 * 1000 : undefined
    };
  }

  /**
   * Force run a reflection cycle (for testing/manual triggering)
   */
  async forceReflection(): Promise<void> {
    logger.info('Manually triggered reflection cycle');
    await this.runReflectionCycle();
  }
}

// Export singleton instance
export const aiReflectionScheduler = new AIReflectionScheduler();

// Auto-start if this module is imported and environment allows
if (process.env.AUTO_START_REFLECTION_SCHEDULER !== 'false') {
  // Small delay to ensure all services are initialized
  setTimeout(() => {
    aiReflectionScheduler.start();
  }, 5000);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  aiReflectionScheduler.stop();
});

process.on('SIGINT', () => {
  aiReflectionScheduler.stop();
});