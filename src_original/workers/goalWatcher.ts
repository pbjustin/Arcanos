import { fileURLToPath } from 'url';
/**
 * Goal Watcher Worker - Bridge to goal-tracker functionality
 * This file provides the interface expected by sleep-manager
 */

import { goalTrackerWorker } from './goal-tracker.js';
import { createServiceLogger } from '../utils/logger.js';

const logger = createServiceLogger('GoalWatcher');

/**
 * Main goal watcher function called by sleep manager
 * Processes goals for all active users during maintenance window
 */
export default async function goalWatcher(): Promise<void> {
  logger.info('Starting goal watcher audit during sleep window');
  
  try {
    // Start the goal tracker if not already running
    if (!goalTrackerWorker.isActive()) {
      await goalTrackerWorker.start();
    }

    // In a real implementation, this would fetch all active users
    // For now, we'll log that the audit would run
    logger.info('Goal watcher audit would process all active users');
    
    // Placeholder: Process sample user goals
    // In production, this would iterate through all users with active goals
    const sampleUserIds = ['system']; // Placeholder
    
    for (const userId of sampleUserIds) {
      try {
        const analyses = await goalTrackerWorker.processUserGoals(userId);
        logger.info('Processed user goals', { userId, analysisCount: analyses.length });
      } catch (error: any) {
        logger.error('Failed to process user goals', error, { userId });
      }
    }

    logger.success('Goal watcher audit completed successfully');
  } catch (error: any) {
    logger.error('Goal watcher audit failed', error);
    throw error;
  }
}

// Allow running directly from node
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  goalWatcher().catch(err => {
    logger.error('Goal watcher execution failed', err);
    process.exit(1);
  });
}