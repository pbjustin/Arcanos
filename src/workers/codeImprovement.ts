/**
 * Code Improvement Worker - Generates daily code improvement suggestions
 * This file provides the interface expected by sleep-manager
 */

import { createServiceLogger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

const logger = createServiceLogger('CodeImprovement');

/**
 * Main code improvement function called by sleep manager
 * Generates and logs code improvement suggestions
 */
export default async function codeImprovement(): Promise<void> {
  logger.info('Starting daily code improvement suggestions during sleep window');
  
  try {
    // Ensure storage directory exists
    const storageDir = path.join(process.cwd(), 'storage', 'code-improvements');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    // Generate improvement suggestions
    const suggestions = await generateImprovementSuggestions();
    
    // Save suggestions to file
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const suggestionFile = path.join(storageDir, `improvements-${timestamp}.json`);
    
    const suggestionData = {
      timestamp: new Date().toISOString(),
      suggestions,
      metadata: {
        nodeVersion: process.version,
        platform: process.platform,
        memoryUsage: process.memoryUsage()
      }
    };

    fs.writeFileSync(suggestionFile, JSON.stringify(suggestionData, null, 2));

    logger.success('Code improvement suggestions generated', { 
      suggestionCount: suggestions.length,
      suggestionFile 
    });

    // Clean up old suggestion files (keep last 30 days)
    await cleanupOldSuggestions(storageDir);

  } catch (error: any) {
    logger.error('Code improvement generation failed', error);
    throw error;
  }
}

/**
 * Generate code improvement suggestions
 */
async function generateImprovementSuggestions(): Promise<string[]> {
  const suggestions = [
    'Review and optimize database queries for performance improvements',
    'Implement proper error handling and logging in all service modules',
    'Add unit tests for critical business logic functions',
    'Consider implementing caching for frequently accessed data',
    'Review and update outdated dependencies for security patches',
    'Optimize memory usage by implementing proper cleanup in workers',
    'Add monitoring and alerting for system health metrics',
    'Implement proper input validation for all API endpoints',
    'Consider using connection pooling for database operations',
    'Review and refactor large functions into smaller, more manageable units',
    'Implement proper TypeScript strict mode for better type safety',
    'Add comprehensive API documentation using OpenAPI/Swagger',
    'Consider implementing rate limiting for public API endpoints',
    'Review and optimize Docker configuration for production deployment',
    'Implement proper backup and recovery procedures for critical data'
  ];

  // Simulate some analysis time
  await new Promise(resolve => setTimeout(resolve, 100));

  // Return a random subset of suggestions (3-7 suggestions)
  const count = Math.floor(Math.random() * 5) + 3;
  const shuffled = suggestions.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

/**
 * Clean up old suggestion files
 */
async function cleanupOldSuggestions(storageDir: string): Promise<void> {
  try {
    const files = fs.readdirSync(storageDir);
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    for (const file of files) {
      if (file.startsWith('improvements-') && file.endsWith('.json')) {
        const filePath = path.join(storageDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < thirtyDaysAgo) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} old improvement suggestion files`);
    }
  } catch (error: any) {
    logger.warning('Failed to cleanup old suggestion files', { error: error.message });
  }
}

// Allow running directly from node
if (require.main === module) {
  codeImprovement().catch(err => {
    logger.error('Code improvement execution failed', err);
    process.exit(1);
  });
}