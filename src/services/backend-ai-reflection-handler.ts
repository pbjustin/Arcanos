// Backend AI Reflection Handler (Scheduled for 8:30 AM Server Sleep)
import { schedule } from 'node-cron';
import * as fs from 'fs';
import path from 'path';

// OpenAI SDK integration
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let allowRuntimeReflection = false;

// Ensure memory directory exists
const memoryDir = path.join(process.cwd(), 'memory');
if (!fs.existsSync(memoryDir)) {
  fs.mkdirSync(memoryDir, { recursive: true });
}

// Schedule reflections at 8:30 AM daily
schedule('30 8 * * *', () => {
  allowRuntimeReflection = true;
  performSelfReflection();
  allowRuntimeReflection = false;
});

function performSelfReflection(): void {
  if (!allowRuntimeReflection) return;

  generateReflection().then(insights => {
    const reflectionLogPath = path.join(memoryDir, 'reflection-log.json');
    fs.writeFileSync(reflectionLogPath, JSON.stringify(insights, null, 2));
    console.log('🧠 Daily AI reflection completed and saved to reflection-log.json');
  }).catch(error => {
    console.error('❌ Failed to perform self-reflection:', error);
  });
}

async function generateReflection(): Promise<any> {
  try {

    const response = await openai.chat.completions.create({
      model: process.env.FINE_TUNE_MODEL || 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are performing a daily self-reflection as the ARCANOS AI system. Analyze your current state, recent activities, and provide insights about your performance and areas for improvement.'
        },
        {
          role: 'user',
          content: `Perform a comprehensive daily self-reflection. Current timestamp: ${new Date().toISOString()}`
        }
      ],
      max_tokens: 2000,
      temperature: 0.3
    });

    return {
      timestamp: new Date().toISOString(),
      reflection: response.choices[0]?.message?.content || 'No reflection content generated',
      model: response.model,
      type: 'daily_reflection',
      scheduledTime: '8:30 AM',
      systemStatus: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform
      }
    };
  } catch (error: any) {
    console.error('Failed to generate AI reflection:', error);
    return {
      timestamp: new Date().toISOString(),
      reflection: 'Failed to generate reflection due to error: ' + error.message,
      error: true,
      type: 'daily_reflection',
      scheduledTime: '8:30 AM'
    };
  }
}

// Test function for manual execution (bypasses allowRuntimeReflection check)
async function testReflection(): Promise<void> {
  console.log('🧪 Testing AI reflection generation...');
  try {
    const insights = await generateReflection();
    const reflectionLogPath = path.join(memoryDir, 'reflection-log.json');
    fs.writeFileSync(reflectionLogPath, JSON.stringify(insights, null, 2));
    console.log('✅ Test reflection completed and saved to reflection-log.json');
  } catch (error) {
    console.error('❌ Test reflection failed:', error);
  }
}

export {
  performSelfReflection as reflectIfScheduled,
  testReflection
};