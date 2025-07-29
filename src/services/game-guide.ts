import { OpenAIService } from './openai';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('GameGuideService');

export interface GameGuideOptions {
  gameTitle: string;
  notes?: string;
}

export interface GameGuideResponse {
  guide: string;
  gameTitle: string;
  model: string;
  timestamp: string;
  error?: string;
}

export class GameGuideService {
  private openaiService: OpenAIService;

  constructor() {
    this.openaiService = new OpenAIService({
      model: 'gpt-3.5-turbo' // Explicitly use gpt-3.5-turbo as specified in the problem statement
    });
  }

  async simulateGameGuide(gameTitle: string, notes: string = ""): Promise<GameGuideResponse> {
    const startTime = Date.now();
    
    logger.info('Game guide generation started', {
      gameTitle,
      hasNotes: !!notes,
      timestamp: new Date().toISOString()
    });

    const prompt = `
You are a strategic AI assistant trained to act as a universal game guide.
Given the game title "${gameTitle}", analyze:
- The game genre and mechanics
- Best early-game strategies
- Mid-game adaptations
- Endgame win conditions
- Common player mistakes
- Situational tactics

Reflect on each recommendation with reasoning and risk mitigation.

${notes ? `User notes: ${notes}` : ""}
Return this as a structured guide with bullet points.
`;

    try {
      const response = await this.openaiService.chat([
        { role: "user", content: prompt }
      ]);

      const endTime = Date.now();
      
      if (response.error) {
        logger.error('Game guide generation failed', {
          gameTitle,
          error: response.error,
          completionTimeMs: endTime - startTime
        });
        
        return {
          guide: '',
          gameTitle,
          model: response.model,
          timestamp: new Date().toISOString(),
          error: response.error
        };
      }

      logger.info('Game guide generation completed', {
        gameTitle,
        guideLength: response.message.length,
        completionTimeMs: endTime - startTime,
        model: response.model
      });

      return {
        guide: response.message,
        gameTitle,
        model: response.model,
        timestamp: new Date().toISOString()
      };

    } catch (error: any) {
      const endTime = Date.now();
      
      logger.error('Game guide generation error', {
        gameTitle,
        error: error.message,
        completionTimeMs: endTime - startTime
      });

      return {
        guide: '',
        gameTitle,
        model: this.openaiService.getModel(),
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  }
}

// Export singleton instance
export const gameGuideService = new GameGuideService();