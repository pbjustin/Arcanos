/**
 * Example usage of Resilient Reflection Memory Handling
 * 
 * This example demonstrates how to use the new reflection memory functions
 * for safe, resilient memory operations with automatic fallback recovery.
 */

import { storeReflection, getReflection } from '../services/reflection-memory';

export async function exampleReflectionUsage() {
  // Example 1: Store user preferences with resilience
  const userPreferences = {
    theme: 'dark',
    language: 'en',
    notifications: true,
    lastActiveModel: 'gpt-4-turbo',
    conversationHistory: ['Welcome message', 'User question', 'AI response']
  };

  // Store with automatic shadow backup
  await storeReflection('/recent/user/123/preferences', userPreferences);
  console.log('✅ User preferences stored with fallback protection');

  // Example 2: Retrieve with automatic error recovery
  const retrieved = await getReflection('/recent/user/123/preferences');
  console.log('✅ Retrieved preferences:', retrieved);

  // Example 3: Handle complex objects safely
  const sessionReflection = {
    sessionId: 'sess_abc123',
    insights: {
      userIntent: 'seeking information about AI models',
      sentiment: 'positive',
      complexity: 'intermediate'
    },
    recommendations: [
      'Provide detailed explanations',
      'Include code examples',
      'Offer follow-up questions'
    ],
    metadata: {
      timestamp: new Date().toISOString(),
      model: 'gpt-4-turbo',
      tokensUsed: 1250
    }
  };

  await storeReflection('/recent/session/sess_abc123/reflection', sessionReflection);
  console.log('✅ Session reflection stored');

  // Example 4: Demonstrate circular reference protection
  const problematicData: any = {
    name: 'test-object',
    data: { value: 42 }
  };
  problematicData.self = problematicData; // Creates circular reference

  // This will be safely handled without throwing errors
  await storeReflection('/recent/test/circular', problematicData);
  const safeResult = await getReflection('/recent/test/circular');
  console.log('✅ Circular reference safely handled:', safeResult);

  return {
    preferences: retrieved,
    reflection: await getReflection('/recent/session/sess_abc123/reflection'),
    circularTest: safeResult
  };
}

// Example integration with existing OpenAI patterns
export async function integrateWithAIWorkflow(userId: string, sessionId: string) {
  // Store AI interaction insights
  const aiInsights = {
    userQuery: 'How do I implement error handling?',
    aiResponse: 'Error handling can be implemented using try-catch blocks...',
    confidence: 0.95,
    followUpSuggestions: [
      'Would you like examples of different error types?',
      'Should I explain async error handling as well?'
    ]
  };

  const reflectionPath = `/recent/ai-insights/${userId}/${sessionId}`;
  await storeReflection(reflectionPath, aiInsights);

  // Later, retrieve for context in next interaction
  const previousInsights = await getReflection(reflectionPath);
  
  return {
    currentInsights: aiInsights,
    retrievedContext: previousInsights
  };
}