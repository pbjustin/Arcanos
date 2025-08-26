/**
 * Example: How to use the ARCANOS Router
 * This demonstrates the different routing patterns available
 */

import { routeRequest, MODELS } from './dist/router.js';

console.log('🎯 ARCANOS Router Usage Example\n');

// Example payload structure
const examplePayload = {
    messages: [
        { role: 'user', content: 'Analyze this data for security vulnerabilities' }
    ]
};

console.log('📋 Available Models:');
console.log('  LIVE_GPT_4_1:', MODELS.LIVE_GPT_4_1);
console.log('  GPT_5:', MODELS.GPT_5);
console.log('  ARCANOS_V2:', MODELS.ARCANOS_V2);
console.log('');

console.log('🔀 Routing Patterns:');
console.log('');

console.log('1. Audit/Logic Sources (GPT-5 → GPT-4.1):');
console.log('   - Use GPT-5 for deep reasoning');
console.log('   - Refine output through GPT-4.1 for formatting');
console.log('   - Sources: "audit", "logic"');
console.log('');

console.log('2. Validation/Schema Sources (ARCANOS-V2 → GPT-4.1):');
console.log('   - Use ARCANOS-V2 (GPT-3.5 fine-tune) for structure');
console.log('   - Refine output through GPT-4.1 for final delivery');
console.log('   - Sources: "validation", "schema"');
console.log('');

console.log('3. Default Sources (Direct GPT-4.1):');
console.log('   - Process directly through GPT-4.1 fine-tune');
console.log('   - Single-stage processing for standard requests');
console.log('   - Sources: any other value');
console.log('');

console.log('📝 Usage Example:');
console.log('```javascript');
console.log('import { routeRequest } from "./router.js";');
console.log('');
console.log('// Audit request → GPT-5 → GPT-4.1');
console.log('const auditResult = await routeRequest({');
console.log('  source: "audit",');
console.log('  payload: {');
console.log('    messages: [');
console.log('      { role: "user", content: "Review this code for issues" }');
console.log('    ]');
console.log('  }');
console.log('});');
console.log('');
console.log('// Validation request → ARCANOS-V2 → GPT-4.1');
console.log('const validationResult = await routeRequest({');
console.log('  source: "validation",');
console.log('  payload: {');
console.log('    messages: [');
console.log('      { role: "user", content: "Validate this data structure" }');
console.log('    ]');
console.log('  }');
console.log('});');
console.log('```');
console.log('');

console.log('✅ Router implementation ready for use!');
console.log('');
console.log('💡 Note: The router will throw an error if OpenAI client is not properly initialized.');
console.log('   Make sure OPENAI_API_KEY is configured in your environment.');