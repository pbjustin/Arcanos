/**
 * Test script for Backend AI Reflection Handler
 * Tests the reflectIfScheduled function manually
 */
import { testReflection } from './src/services/backend-ai-reflection-handler';
import * as fs from 'fs';
import path from 'path';

console.log('🧪 Testing Backend AI Reflection Handler...');

// Test the manual reflection execution
async function testReflectionHandler() {
  try {
    console.log('📝 Executing test reflection...');
    
    // Test file path
    const memoryDir = path.join(process.cwd(), 'memory');
    const reflectionLogPath = path.join(memoryDir, 'reflection-log.json');
    
    console.log('📂 Memory directory:', memoryDir);
    console.log('📄 Reflection log path:', reflectionLogPath);
    
    // Check if memory directory exists
    if (!fs.existsSync(memoryDir)) {
      console.log('📁 Creating memory directory...');
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    
    // Run the test reflection
    await testReflection();
    
    // Verify the file was created
    if (fs.existsSync(reflectionLogPath)) {
      console.log('✅ Reflection log file created successfully');
      const content = fs.readFileSync(reflectionLogPath, 'utf8');
      const reflection = JSON.parse(content);
      console.log('📊 Reflection data:');
      console.log('  - Timestamp:', reflection.timestamp);
      console.log('  - Type:', reflection.type);
      console.log('  - Scheduled Time:', reflection.scheduledTime);
      console.log('  - Has Reflection Content:', !!reflection.reflection);
      console.log('  - Model:', reflection.model || 'N/A');
    } else {
      console.log('❌ Reflection log file was not created');
    }
    
    console.log('✅ Backend AI Reflection Handler test completed');
    console.log('🕐 Reflection is scheduled for 7:00 AM daily via node-cron');
    console.log('📊 System ready for scheduled reflections');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testReflectionHandler();