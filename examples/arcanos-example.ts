/**
 * Example demonstrating ARCANOS system diagnosis functionality
 * This shows how to use the arcanosPrompt wrapper and runARCANOS function
 */

import { arcanosPrompt, runARCANOS } from '../logic/arcanos.js';
import OpenAI from 'openai';

// Initialize OpenAI client (requires API key)
function initializeOpenAI(): OpenAI | null {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌ No OpenAI API key found');
    return null;
  }
  return new OpenAI({ apiKey });
}

// Example from the problem statement
export async function demonstrateArcanosUsage() {
  console.log('🔬 Demonstrating ARCANOS system diagnosis...\n');
  
  const openai = initializeOpenAI();
  if (!openai) {
    console.error('Cannot run example without OpenAI API key');
    return;
  }

  // Example 1: Show the prompt wrapper
  console.log('1. ARCANOS Prompt Wrapper:');
  const wrappedPrompt = arcanosPrompt("Run system diagnosis.");
  console.log(wrappedPrompt);
  console.log('\n' + '='.repeat(50) + '\n');

  // Example 2: Run the full ARCANOS diagnosis
  console.log('2. Running ARCANOS System Diagnosis:');
  try {
    const result = await runARCANOS(openai, "Run system diagnosis.");
    
    console.log('✅ Component Status:');
    console.log(result.componentStatus);
    console.log('\n🛠 Suggested Fixes:');
    console.log(result.suggestedFixes);
    console.log('\n🧠 Core Logic Trace:');
    console.log(result.coreLogicTrace);
    console.log('\nFull Response:');
    console.log(result.result);
    
  } catch (error) {
    console.error('❌ Error running ARCANOS:', error);
  }
}

// Run the example if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateArcanosUsage().catch(console.error);
}