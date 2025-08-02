// ARCANOS Backend - Full AI Control Delegation
// This entry point delegates all operations to the AI-controlled TypeScript backend

console.log('🤖 ARCANOS: Delegating full operational control to AI model...');

// Memory diagnostics and garbage collection helpers
require('./diagnostics');
require('./memory.js');
const memoryManager = require('./utils/memoryManager');
setInterval(memoryManager.monitorMemory, 15000); // Monitor every 15s

// All logic has been moved to TypeScript AI-controlled backend
// This ensures the fine-tuned ARCANOS model has complete operational control
require('./dist/index.js');
