/**
 * Test for ARCANOS system diagnosis functionality
 */

import { arcanosPrompt } from '../dist/logic/arcanos.js';

console.log('🧪 Testing ARCANOS functionality...\n');

// Test 1: Test the arcanosPrompt wrapper
console.log('Test 1: arcanosPrompt wrapper');
const testInput = "Run system diagnosis.";
const wrappedPrompt = arcanosPrompt(testInput);

console.log('Input:', testInput);
console.log('Wrapped prompt:');
console.log(wrappedPrompt);

// Verify the prompt contains expected elements
const expectedElements = [
  'ARCANOS — a modular AI operating core',
  'USER COMMAND',
  testInput,
  'RESPONSE FORMAT',
  '✅ Component Status Table',
  '🛠 Suggested Fixes', 
  '🧠 Core Logic Trace'
];

let allElementsPresent = true;
for (const element of expectedElements) {
  if (!wrappedPrompt.includes(element)) {
    console.error(`❌ Missing expected element: ${element}`);
    allElementsPresent = false;
  }
}

if (allElementsPresent) {
  console.log('✅ All expected elements present in wrapped prompt');
} else {
  console.log('❌ Some expected elements missing');
  process.exit(1);
}

console.log('\n✅ ARCANOS prompt wrapper test passed!');

// Test 2: Validate structure
console.log('\nTest 2: Prompt structure validation');
const lines = wrappedPrompt.split('\n');
const hasUserCommand = lines.some(line => line.includes('[USER COMMAND]'));
const hasResponseFormat = lines.some(line => line.includes('[RESPONSE FORMAT]'));
const hasComponentStatus = lines.some(line => line.includes('✅ Component Status Table'));
const hasSuggestedFixes = lines.some(line => line.includes('🛠 Suggested Fixes'));
const hasCoreLogicTrace = lines.some(line => line.includes('🧠 Core Logic Trace'));

if (hasUserCommand && hasResponseFormat && hasComponentStatus && hasSuggestedFixes && hasCoreLogicTrace) {
  console.log('✅ Prompt structure is correct');
} else {
  console.log('❌ Prompt structure validation failed');
  process.exit(1);
}

console.log('\n🎉 All ARCANOS tests passed!');