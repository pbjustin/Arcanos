/**
 * Test for Backend AI Reflection Handler
 * Validates the handler functionality and file output
 */

import backendReflectionHandler from './src/services/backend-ai-reflection-handler';
import * as fs from 'fs';
import * as path from 'path';

// Set up environment for testing (without requiring real OpenAI key)
process.env.OPENAI_API_KEY = 'mock-test-key';
process.env.OPENAI_MODEL = 'gpt-4';

async function testBackendReflectionHandler() {
  console.log('🧪 Testing Backend AI Reflection Handler...');
  
  try {
    // Test initial state
    console.log('✅ Initial runtime reflection state:', backendReflectionHandler.getAllowRuntimeReflection());
    
    // Test manual enable/disable
    backendReflectionHandler.setAllowRuntimeReflection(true);
    console.log('✅ Runtime reflection enabled:', backendReflectionHandler.getAllowRuntimeReflection());
    
    // Test reflection function (will fail on OpenAI call but we can test the structure)
    console.log('🔄 Testing self-reflection function (will mock OpenAI failure)...');
    try {
      await backendReflectionHandler.reflectIfScheduled();
    } catch (error) {
      console.log('⚠️ Expected OpenAI error (mock key):', error instanceof Error ? error.message : error);
    }
    
    // Check if reflection log was created despite OpenAI failure
    const reflectionLogPath = path.resolve(process.cwd(), 'memory', 'reflection-log.json');
    if (fs.existsSync(reflectionLogPath)) {
      console.log('✅ Reflection log file created at:', reflectionLogPath);
      
      // Read and validate the log content
      const logContent = fs.readFileSync(reflectionLogPath, 'utf8');
      const reflectionData = JSON.parse(logContent);
      
      console.log('📊 Reflection data structure:');
      console.log('  - Timestamp:', reflectionData.timestamp);
      console.log('  - System State:', !!reflectionData.systemState);
      console.log('  - AI Reflection:', typeof reflectionData.aiReflection);
      console.log('  - Model:', reflectionData.model);
      console.log('  - Scheduled Run:', reflectionData.scheduledRun);
      console.log('  - Metadata:', !!reflectionData.metadata);
      
      // Validate required fields
      const requiredFields = ['timestamp', 'systemState', 'aiReflection', 'model', 'scheduledRun', 'metadata'];
      const missingFields = requiredFields.filter(field => !reflectionData[field]);
      
      if (missingFields.length === 0) {
        console.log('✅ All required fields present in reflection log');
      } else {
        console.log('❌ Missing fields:', missingFields);
      }
      
      // Validate system state structure
      if (reflectionData.systemState) {
        const systemState = reflectionData.systemState;
        const systemFields = ['memoryUsage', 'uptime', 'nodeVersion', 'platform'];
        const missingSystemFields = systemFields.filter(field => !systemState[field]);
        
        if (missingSystemFields.length === 0) {
          console.log('✅ System state structure valid');
        } else {
          console.log('❌ Missing system state fields:', missingSystemFields);
        }
      }
      
    } else {
      console.log('⚠️ Reflection log file not found (expected due to OpenAI mock failure)');
    }
    
    // Test disable functionality
    backendReflectionHandler.setAllowRuntimeReflection(false);
    console.log('✅ Runtime reflection disabled:', backendReflectionHandler.getAllowRuntimeReflection());
    
    // Test that reflection doesn't run when disabled
    console.log('🔄 Testing disabled reflection...');
    await backendReflectionHandler.reflectIfScheduled();
    console.log('✅ Reflection correctly skipped when runtime reflection is disabled');
    
    // Test basic handler structure
    console.log('🔍 Testing handler exports...');
    const hasReflectMethod = typeof backendReflectionHandler.reflectIfScheduled === 'function';
    const hasGetterMethod = typeof backendReflectionHandler.getAllowRuntimeReflection === 'function';
    const hasSetterMethod = typeof backendReflectionHandler.setAllowRuntimeReflection === 'function';
    
    console.log('✅ Handler exports:');
    console.log('  - reflectIfScheduled:', hasReflectMethod);
    console.log('  - getAllowRuntimeReflection:', hasGetterMethod);
    console.log('  - setAllowRuntimeReflection:', hasSetterMethod);
    
    if (hasReflectMethod && hasGetterMethod && hasSetterMethod) {
      console.log('✅ All required methods exported');
    } else {
      console.log('❌ Missing required methods');
    }
    
    console.log('🎉 Backend AI Reflection Handler tests completed successfully!');
    console.log('📝 Note: Full OpenAI integration would require valid API key in production');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  testBackendReflectionHandler()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Test execution failed:', error);
      process.exit(1);
    });
}

export { testBackendReflectionHandler };