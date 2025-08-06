/**
 * Demonstrate the ARCANOS prompt wrapper functionality
 * This doesn't require an OpenAI API key - just shows the prompt formatting
 */

import { arcanosPrompt } from '../dist/logic/arcanos.js';

console.log('🔬 ARCANOS Prompt Wrapper Demo\n');
console.log('='.repeat(60));

// Example from the problem statement
const userInput = "Run system diagnosis.";
const wrappedPrompt = arcanosPrompt(userInput);

console.log('Original user input:');
console.log(`"${userInput}"`);
console.log('\n' + '-'.repeat(60));
console.log('\nARCANOS wrapped prompt:');
console.log(wrappedPrompt);
console.log('\n' + '='.repeat(60));

console.log('\n✅ This is exactly what gets sent to GPT-4 when runARCANOS() is called');
console.log('🛠  The AI will respond with the three sections:');
console.log('   ✅ Component Status Table');
console.log('   🛠 Suggested Fixes');  
console.log('   🧠 Core Logic Trace');