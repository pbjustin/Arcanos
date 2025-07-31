// Backend AI Reflection Handler
import { schedule } from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('BackendAIReflectionHandler');

// Disable live reflection
let allowRuntimeReflection = false;

// SDK-compliant OpenAI usage
let openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

// Interface for reflection insights
interface ReflectionInsights {
  timestamp: string;
  systemState: {
    memoryUsage: NodeJS.MemoryUsage;
    uptime: number;
    nodeVersion: string;
    platform: string;
  };
  aiReflection: string;
  model: string;
  scheduledRun: boolean;
  metadata: {
    version: string;
    handler: string;
    runtimeConstraints: boolean;
  };
}

// Schedule memory reflections for low-activity windows (e.g., 2:00 AM daily)
schedule('0 2 * * *', async () => {
  logger.info('Scheduled reflection starting at 2:00 AM');
  allowRuntimeReflection = true;
  try {
    await performSelfReflection();
  } catch (error) {
    logger.error('Scheduled reflection failed', error);
  } finally {
    allowRuntimeReflection = false;
    logger.info('Scheduled reflection completed, runtime reflection disabled');
  }
});

// Generate reflection using OpenAI
async function generateReflection(): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are performing a backend AI reflection during a scheduled low-activity window. Analyze your current operational state and provide insights about:
      1. System performance and health
      2. Memory usage and optimization opportunities
      3. Recent operational patterns
      4. Areas for improvement or concern
      5. Runtime efficiency observations
      
      Keep your reflection concise but insightful, focusing on backend operations and system health.`
    },
    {
      role: 'user',
      content: `Perform a backend system reflection. Current timestamp: ${new Date().toISOString()}`
    }
  ];

  try {
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4',
      messages,
      max_tokens: 1500,
      temperature: 0.3
    });

    return completion.choices[0]?.message?.content || 'Reflection generation failed';
  } catch (error) {
    logger.error('OpenAI reflection generation failed', error);
    return `Reflection generation error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// Reflection function
async function performSelfReflection(): Promise<void> {
  if (!allowRuntimeReflection) {
    logger.debug('Runtime reflection not allowed - ignoring request');
    return;
  }
  
  logger.info('Performing self-reflection');
  
  try {
    const aiReflection = await generateReflection();
    
    const insights: ReflectionInsights = {
      timestamp: new Date().toISOString(),
      systemState: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform
      },
      aiReflection,
      model: process.env.OPENAI_MODEL || 'gpt-4',
      scheduledRun: true,
      metadata: {
        version: '1.0.0',
        handler: 'backend-ai-reflection-handler',
        runtimeConstraints: true
      }
    };

    // Ensure memory directory exists
    const memoryDir = path.resolve(process.cwd(), 'memory');
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
      logger.info('Created memory directory');
    }

    const reflectionLogPath = path.join(memoryDir, 'reflection-log.json');
    fs.writeFileSync(reflectionLogPath, JSON.stringify(insights, null, 2));
    
    logger.info('Self-reflection completed and saved to reflection-log.json', {
      path: reflectionLogPath,
      timestamp: insights.timestamp
    });
  } catch (error) {
    logger.error('Self-reflection failed', error);
    throw error;
  }
}

// Ensure logic respects memory and runtime constraints
export default {
  reflectIfScheduled: performSelfReflection,
  getAllowRuntimeReflection: () => allowRuntimeReflection,
  setAllowRuntimeReflection: (allow: boolean) => {
    allowRuntimeReflection = allow;
    logger.info(`Runtime reflection ${allow ? 'enabled' : 'disabled'} manually`);
  }
};