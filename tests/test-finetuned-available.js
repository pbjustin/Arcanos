import { createServer } from 'http';
import { URL } from 'url';

/**
 * Test that the fine-tuned model is used when available
 */

// Mock OpenAI API server that has the fine-tuned model available
function createMockOpenAIServerWithFineTuned() {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    console.log(`Mock OpenAI API: ${req.method} ${path}`);

    // Mock models.retrieve endpoint
    if (path.startsWith('/v1/models/')) {
      const modelId = path.split('/v1/models/')[1];
      
      if (modelId === 'ft:arcanos-v2') {
        // Simulate fine-tuned model IS available
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'ft:arcanos-v2',
          object: 'model',
          created: 1687882411,
          owned_by: 'user-123'
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Model not found" } }));
      }
    }
    // Mock chat completions endpoint
    else if (path === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const model = data.model;
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: `Test response from ${model}`
              },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15
            }
          }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
        }
      });
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
    }
  });
}

async function testFineTunedModelUsage() {
  console.log('🧪 Starting fine-tuned model availability test...');
  
  // Start mock OpenAI server
  const mockServer = createMockOpenAIServerWithFineTuned();
  await new Promise(resolve => mockServer.listen(8889, resolve));
  console.log('🔧 Mock OpenAI server started on port 8889');

  try {
    // Test with mock OpenAI endpoint
    process.env.OPENAI_BASE_URL = 'http://localhost:8889/v1';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MODEL_ID = 'ft:arcanos-v2';

    // Import trinity module (this will use the environment variables)
    const { runThroughBrain } = await import('../dist/logic/trinity.js');
    const OpenAI = (await import('openai')).default;
    
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL
    });

    console.log('🧠 Testing fine-tuned model usage when available...');
    
    // Capture console output to verify NO fallback message
    const originalWarn = console.warn;
    let warningMessage = '';
    console.warn = (msg) => {
      warningMessage = msg;
      originalWarn(msg);
    };

    // Run trinity brain (should use ft:arcanos-v2)
    const result = await runThroughBrain(client, 'Hello, test message');
    
    // Restore console.warn
    console.warn = originalWarn;

    console.log('📝 Result:', result);
    
    // Verify NO fallback occurred
    if (warningMessage === '') {
      console.log('✅ No fallback warning - fine-tuned model was used directly');
    } else {
      console.log('❌ Unexpected warning message:', warningMessage);
    }

    // Verify result uses fine-tuned model
    if (result.module === 'ft:arcanos-v2') {
      console.log('✅ System correctly used the fine-tuned model');
    } else {
      console.log('❌ Expected module to be ft:arcanos-v2, got:', result.module);
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    mockServer.close();
    console.log('🔧 Mock server stopped');
  }
}

// Run the test
testFineTunedModelUsage().catch(console.error);