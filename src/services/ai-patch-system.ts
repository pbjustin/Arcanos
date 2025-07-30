// AI Patch System - Dynamic Content Management with Git Integration
// Handles OpenAI SDK output, file operations, and Git commits with retry logic

import fs from 'fs/promises';
import path from 'path';
import { Octokit } from "@octokit/rest";
import { writeMemory, getMemory } from "./memory";

interface PatchContent {
  content: string;
  filename: string;
  taskDescription?: string;
}

interface PatchResult {
  success: boolean;
  sha?: string;
  filePath?: string;
  error?: string;
  timestamp: string;
}

interface RetryQueueItem {
  content: string;
  filename: string;
  taskDescription?: string;
  attemptCount: number;
  lastAttempt: string;
  originalTimestamp: string;
}

export class AIPatchSystemService {
  private octokit: Octokit;
  private repoOwner: string;
  private repoName: string;
  private baseDir: string;
  private logsDir: string;
  private retryQueueKey = '/patch_system/retry_queue';
  private maxRetries = 3;

  constructor() {
    // Initialize GitHub client
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.warn('[AI-PATCH-SYSTEM] No GitHub token found. Git operations will fail.');
    }
    
    this.octokit = new Octokit({ auth: githubToken });
    
    // Get repository info from environment or default
    this.repoOwner = process.env.GITHUB_OWNER || 'pbjustin';
    this.repoName = process.env.GITHUB_REPO || 'Arcanos';
    
    // Set up directories
    this.baseDir = process.cwd();
    this.logsDir = path.join(this.baseDir, 'logs');
    
    this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    try {
      await fs.access(this.logsDir);
    } catch {
      await fs.mkdir(this.logsDir, { recursive: true });
    }
  }

  /**
   * Main patch operation - accepts OpenAI SDK output and processes it
   */
  async processPatch(patchData: PatchContent): Promise<PatchResult> {
    const timestamp = new Date().toISOString();
    
    try {
      // Step 1: Validate input
      if (!patchData.content || !patchData.filename) {
        throw new Error('Content and filename are required');
      }

      // Step 2: Save content to file
      const filePath = await this.saveContentToFile(patchData.content, patchData.filename);
      
      // Step 3: Stage file for Git commit
      // In this implementation, we'll use GitHub API directly for atomic operations
      
      // Step 4: Commit with timestamped message
      const commitMessage = this.generateCommitMessage(patchData.filename, timestamp, patchData.taskDescription);
      
      // Step 5: Push to main branch and get SHA
      const sha = await this.commitAndPushFile(filePath, patchData.content, commitMessage);
      
      // Step 6: Log success
      await this.logSuccess(patchData.filename, sha, timestamp);
      
      return {
        success: true,
        sha,
        filePath,
        timestamp
      };
      
    } catch (error: any) {
      // Step 7: Handle failure - log error and queue for retry
      const errorMessage = error.message || 'Unknown error occurred';
      await this.logError(patchData, errorMessage, timestamp);
      await this.queueForRetry(patchData, timestamp);
      
      return {
        success: false,
        error: errorMessage,
        timestamp
      };
    }
  }

  /**
   * Save content to a local file
   */
  private async saveContentToFile(content: string, filename: string): Promise<string> {
    const filePath = path.join(this.baseDir, filename);
    
    // Ensure directory exists
    const dir = path.dirname(filePath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
    
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  /**
   * Generate timestamped commit message
   */
  private generateCommitMessage(filename: string, timestamp: string, taskDescription?: string): string {
    const datetime = new Date(timestamp).toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    });
    
    const task = taskDescription ? ` - ${taskDescription}` : '';
    return `AI patch update - ${filename} - ${datetime}${task}`;
  }

  /**
   * Commit file and push to main branch using GitHub API
   */
  private async commitAndPushFile(filePath: string, content: string, message: string): Promise<string> {
    const relativePath = path.relative(this.baseDir, filePath);
    const base64Content = Buffer.from(content).toString('base64');
    
    try {
      // Check if file exists
      let sha: string | undefined;
      try {
        const response = await this.octokit.repos.getContent({
          owner: this.repoOwner,
          repo: this.repoName,
          path: relativePath,
          ref: 'main'
        });
        
        if (!Array.isArray(response.data) && 'sha' in response.data) {
          sha = response.data.sha;
        }
      } catch (error: any) {
        // File doesn't exist, which is fine for new files
        if (error.status !== 404) {
          throw error;
        }
      }
      
      // Create or update file
      const result = await this.octokit.repos.createOrUpdateFileContents({
        owner: this.repoOwner,
        repo: this.repoName,
        path: relativePath,
        message,
        content: base64Content,
        branch: 'main',
        ...(sha && { sha })
      });
      
      if (!result.data.commit?.sha) {
        throw new Error('Failed to get commit SHA from GitHub response');
      }
      
      return result.data.commit.sha;
      
    } catch (error: any) {
      throw new Error(`Git operation failed: ${error.message}`);
    }
  }

  /**
   * Log successful patch operation
   */
  private async logSuccess(filename: string, sha: string, timestamp: string): Promise<void> {
    const logEntry = {
      filename,
      sha,
      timestamp,
      status: 'success'
    };
    
    const logPath = path.join(this.logsDir, 'patch_success.log');
    const logLine = `${timestamp} SUCCESS ${filename} ${sha}\n`;
    
    try {
      await fs.appendFile(logPath, logLine);
      
      // Also store in memory for system tracking
      await writeMemory('/logs/patch_success_latest', logEntry);
    } catch (error) {
      console.error('[AI-PATCH-SYSTEM] Failed to log success:', error);
    }
  }

  /**
   * Log patch failure
   */
  private async logError(patchData: PatchContent, error: string, timestamp: string): Promise<void> {
    const logEntry = {
      filename: patchData.filename,
      error,
      timestamp,
      taskDescription: patchData.taskDescription,
      status: 'failed'
    };
    
    const logPath = path.join(this.logsDir, 'patch_failures.log');
    const logLine = `${timestamp} ERROR ${patchData.filename} ${error}\n`;
    
    try {
      await fs.appendFile(logPath, logLine);
      
      // Also store in memory for system tracking
      await writeMemory('/logs/patch_error_latest', logEntry);
    } catch (logError) {
      console.error('[AI-PATCH-SYSTEM] Failed to log error:', logError);
    }
  }

  /**
   * Queue failed patch for retry on next heartbeat
   */
  private async queueForRetry(patchData: PatchContent, timestamp: string): Promise<void> {
    try {
      // Get existing retry queue
      const existingQueue = await getMemory(this.retryQueueKey) || [];
      const queue: RetryQueueItem[] = Array.isArray(existingQueue) ? existingQueue : [];
      
      // Add new item to retry queue
      const retryItem: RetryQueueItem = {
        content: patchData.content,
        filename: patchData.filename,
        taskDescription: patchData.taskDescription,
        attemptCount: 1,
        lastAttempt: timestamp,
        originalTimestamp: timestamp
      };
      
      queue.push(retryItem);
      
      // Save updated queue
      await writeMemory(this.retryQueueKey, queue);
      
      console.log(`[AI-PATCH-SYSTEM] Queued ${patchData.filename} for retry`);
    } catch (error) {
      console.error('[AI-PATCH-SYSTEM] Failed to queue for retry:', error);
    }
  }

  /**
   * Process retry queue - called on heartbeat
   */
  async processRetryQueue(): Promise<void> {
    try {
      const queue = await getMemory(this.retryQueueKey) || [];
      if (!Array.isArray(queue) || queue.length === 0) {
        return;
      }

      const processedItems: RetryQueueItem[] = [];
      
      for (const item of queue) {
        if (item.attemptCount >= this.maxRetries) {
          // Max retries reached, remove from queue
          console.log(`[AI-PATCH-SYSTEM] Max retries reached for ${item.filename}, removing from queue`);
          continue;
        }
        
        // Check if enough time has passed since last attempt (5 minutes minimum)
        const lastAttemptTime = new Date(item.lastAttempt).getTime();
        const now = new Date().getTime();
        const timeSinceLastAttempt = now - lastAttemptTime;
        const minRetryDelay = 5 * 60 * 1000; // 5 minutes
        
        if (timeSinceLastAttempt < minRetryDelay) {
          // Not enough time has passed, add back to queue without retrying
          processedItems.push(item);
          continue;
        }
        
        // Attempt retry
        console.log(`[AI-PATCH-SYSTEM] Retrying patch for ${item.filename} (attempt ${item.attemptCount + 1})`);
        
        const result = await this.processPatch({
          content: item.content,
          filename: item.filename,
          taskDescription: item.taskDescription
        });
        
        if (result.success) {
          console.log(`[AI-PATCH-SYSTEM] Retry successful for ${item.filename}`);
          // Don't add back to queue
        } else {
          // Increment attempt count and add back to queue
          item.attemptCount++;
          item.lastAttempt = new Date().toISOString();
          processedItems.push(item);
        }
        
        // Add delay between retry attempts to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Update queue with remaining items
      await writeMemory(this.retryQueueKey, processedItems);
      
    } catch (error) {
      console.error('[AI-PATCH-SYSTEM] Error processing retry queue:', error);
    }
  }

  /**
   * Get retry queue status
   */
  async getRetryQueueStatus(): Promise<{ queueLength: number; items: RetryQueueItem[] }> {
    try {
      const queue = await getMemory(this.retryQueueKey) || [];
      return {
        queueLength: Array.isArray(queue) ? queue.length : 0,
        items: Array.isArray(queue) ? queue : []
      };
    } catch (error) {
      console.error('[AI-PATCH-SYSTEM] Error getting retry queue status:', error);
      return { queueLength: 0, items: [] };
    }
  }

  /**
   * Get system status and recent logs
   */
  async getSystemStatus(): Promise<any> {
    try {
      const retryStatus = await this.getRetryQueueStatus();
      const successLog = await getMemory('/logs/patch_success_latest');
      const errorLog = await getMemory('/logs/patch_error_latest');
      
      return {
        retryQueue: retryStatus,
        lastSuccess: successLog,
        lastError: errorLog,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[AI-PATCH-SYSTEM] Error getting system status:', error);
      return {
        error: 'Failed to get system status',
        timestamp: new Date().toISOString()
      };
    }
  }
}

// Singleton instance
export const aiPatchSystem = new AIPatchSystemService();

// Helper function for direct usage
export async function createAIPatch(content: string, filename: string, taskDescription?: string): Promise<PatchResult> {
  return aiPatchSystem.processPatch({ content, filename, taskDescription });
}