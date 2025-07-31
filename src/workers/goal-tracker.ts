/**
 * Goal Tracker Worker - Monitors and tracks user goals using OpenAI SDK
 * Uses streaming for long-running goal analysis operations
 */

import { getUnifiedOpenAI } from '../services/unified-openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createServiceLogger } from '../utils/logger';
import { databaseService } from '../services/database';
import fs from 'fs';
import path from 'path';

const logger = createServiceLogger('GoalTracker');

export interface Goal {
  id: string;
  userId: string;
  title: string;
  description: string;
  targetDate?: Date;
  status: 'active' | 'completed' | 'paused' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  progress: number; // 0-100
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalAnalysis {
  goalId: string;
  analysisType: 'progress' | 'obstacle' | 'suggestion' | 'milestone';
  content: string;
  confidence: number;
  recommendedActions: string[];
  timestamp: Date;
}

class GoalTrackerWorker {
  private logDir: string;
  private isRunning: boolean = false;

  constructor() {
    this.logDir = path.join(process.cwd(), 'storage', 'goal-logs');
    this.ensureLogDirectory();
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Analyze goal progress using streaming AI
   */
  async analyzeGoalProgress(goal: Goal, recentActivities: string[] = []): Promise<GoalAnalysis> {
    logger.info('Starting goal progress analysis', { goalId: goal.id, userId: goal.userId });

    const logPath = path.join(this.logDir, `goal-analysis-${goal.id}-${Date.now()}.log`);
    const fileStream = fs.createWriteStream(logPath, { flags: 'a' });

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are ARCANOS analyzing user goal progress. Provide actionable insights and recommendations.
        
Goal Analysis Framework:
- Current progress assessment
- Identify potential obstacles
- Suggest specific next steps
- Recommend timeline adjustments if needed
- Provide encouragement and motivation`
      },
      {
        role: 'user',
        content: `Analyze this goal:

Title: ${goal.title}
Description: ${goal.description}
Current Progress: ${goal.progress}%
Priority: ${goal.priority}
Status: ${goal.status}
Target Date: ${goal.targetDate?.toISOString() || 'Not set'}

Recent Activities:
${recentActivities.length > 0 ? recentActivities.join('\n') : 'No recent activities recorded'}

Please provide:
1. Progress assessment
2. Key obstacles (if any)
3. Specific next steps
4. Timeline recommendations
5. Motivational insights`
      }
    ];

    let analysisContent = '';
    const unifiedOpenAI = getUnifiedOpenAI();
    const result = await unifiedOpenAI.chatStream(
      messages.map(msg => ({
        role: msg.role as any,
        content: msg.content as string,
      })),
      (token: string, isComplete: boolean) => {
        if (!isComplete) {
          process.stdout.write(token);
          fileStream.write(token);
          analysisContent += token;
        }
      },
      {
        maxTokens: 1500,
        temperature: 0.6,
      }
    );

    fileStream.end();

    if (!result.success) {
      logger.error('Goal analysis failed', { goalId: goal.id, error: result.error });
      throw new Error(`Goal analysis failed: ${result.error}`);
    }

    // Extract recommendations using AI
    const recommendedActions = await this.extractRecommendations(analysisContent);

    const analysis: GoalAnalysis = {
      goalId: goal.id,
      analysisType: 'progress',
      content: analysisContent,
      confidence: 0.85, // Could be determined by AI in future iterations
      recommendedActions,
      timestamp: new Date()
    };

    logger.success('Goal analysis completed', { 
      goalId: goal.id, 
      contentLength: analysisContent.length,
      logPath 
    });

    return analysis;
  }

  /**
   * Extract actionable recommendations from analysis content
   */
  private async extractRecommendations(analysisContent: string): Promise<string[]> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: 'Extract 3-5 specific, actionable recommendations from the goal analysis. Return as a JSON array of strings.'
      },
      {
        role: 'user',
        content: `Analysis content: ${analysisContent}

Extract specific actionable recommendations and return them as a JSON array.`
      }
    ];

    const unifiedOpenAI = getUnifiedOpenAI();
    const result = await unifiedOpenAI.complete(messages, 'extract-recommendations', {
      maxTokens: 500,
      temperature: 0.3
    });

    if (!result.success) {
      return ['Continue current progress', 'Review goal timeline', 'Seek additional resources'];
    }

    try {
      const recommendations = JSON.parse(result.content);
      return Array.isArray(recommendations) ? recommendations : [];
    } catch (error) {
      logger.warning('Failed to parse recommendations JSON', { content: result.content });
      return result.content.split('\n').filter((line: string) => line.trim().length > 0).slice(0, 5);
    }
  }

  /**
   * Process all active goals for a user
   */
  async processUserGoals(userId: string): Promise<GoalAnalysis[]> {
    logger.info('Processing user goals', { userId });

    try {
      // In a real implementation, this would fetch from database
      // For now, we'll create a sample structure
      const activeGoals: Goal[] = await this.getUserActiveGoals(userId);
      
      if (activeGoals.length === 0) {
        logger.info('No active goals found for user', { userId });
        return [];
      }

      const analyses: GoalAnalysis[] = [];
      
      for (const goal of activeGoals) {
        try {
          const recentActivities = await this.getRecentActivitiesForGoal(goal.id);
          const analysis = await this.analyzeGoalProgress(goal, recentActivities);
          analyses.push(analysis);
          
          // Store analysis in database (if available)
          await this.storeGoalAnalysis(analysis);
          
        } catch (error: any) {
          logger.error('Failed to analyze goal', error, { goalId: goal.id });
        }
      }

      logger.success('User goal processing completed', { 
        userId, 
        totalGoals: activeGoals.length,
        successfulAnalyses: analyses.length 
      });

      return analyses;
    } catch (error: any) {
      logger.error('Failed to process user goals', error, { userId });
      throw error;
    }
  }

  /**
   * Placeholder for database goal retrieval
   */
  private async getUserActiveGoals(userId: string): Promise<Goal[]> {
    // This would normally query the database for active goals
    // For now, return empty array to prevent errors during implementation
    return [];
  }

  /**
   * Placeholder for activity retrieval
   */
  private async getRecentActivitiesForGoal(goalId: string): Promise<string[]> {
    // This would normally fetch recent activities related to the goal
    return [];
  }

  /**
   * Store goal analysis in database
   */
  private async storeGoalAnalysis(analysis: GoalAnalysis): Promise<void> {
    try {
      // In a real implementation, this would store in database
      // For now, just log that we would store it
      logger.info('Goal analysis would be stored', { 
        goalId: analysis.goalId,
        analysisType: analysis.analysisType 
      });
    } catch (error: any) {
      logger.error('Failed to store goal analysis', error, { goalId: analysis.goalId });
    }
  }

  /**
   * Start the goal tracking worker
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warning('Goal tracker already running');
      return;
    }

    this.isRunning = true;
    logger.info('Goal tracker worker started');

    // In a production environment, this would run on a schedule
    // For now, we'll just mark it as started
  }

  /**
   * Stop the goal tracking worker
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info('Goal tracker worker stopped');
  }

  /**
   * Check if worker is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// Export singleton instance
export const goalTrackerWorker = new GoalTrackerWorker();

// Allow running directly from node
if (require.main === module) {
  const [, , userId] = process.argv;
  if (!userId) {
    console.log('Usage: node goal-tracker.js <userId>');
    process.exit(1);
  }
  
  goalTrackerWorker.processUserGoals(userId).catch(err => {
    logger.error('Goal tracker execution failed', err);
    process.exit(1);
  });
}