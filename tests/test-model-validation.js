import { createServer } from 'http';
import { URL } from 'url';

/**
 * Test the model validation and fallback functionality
 * This test checks that the system properly validates the fine-tuned model
 * and falls back to GPT-4 when the model is unavailable.
 */

// Mock OpenAI API server
function createMockOpenAIServer() {
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
        // Simulate fine-tuned model not found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: "That model does not exist",
            type: "invalid_request_error",
            param: null,
            code: "model_not_found"
          }
        }));
      } else if (modelId === 'gpt-4') {
        // Simulate GPT-4 is available
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'gpt-4',
          object: 'model',
          created: 1687882411,
          owned_by: 'openai'
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

async function testModelValidation() {
  console.log('🧪 Starting model validation test...');
  
  // Start mock OpenAI server
  const mockServer = createMockOpenAIServer();
  await new Promise(resolve => mockServer.listen(8888, resolve));
  console.log('🔧 Mock OpenAI server started on port 8888');

  try {
    // Test with mock OpenAI endpoint
    process.env.OPENAI_BASE_URL = 'http://localhost:8888/v1';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MODEL_ID = 'ft:arcanos-v2';

    // Import trinity module (this will use the environment variables)
    const { runThroughBrain } = await import('../dist/logic/trinity.js');
    const OpenAI = (await import('openai')).default;
    
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL
    });

    console.log('🧠 Testing model validation and fallback...');
    
    // Capture console output to verify fallback message
    const originalWarn = console.warn;
    let warningMessage = '';
    console.warn = (msg) => {
      warningMessage = msg;
      originalWarn(msg);
    };

    // Run trinity brain (should fallback to GPT-4)
    const result = await runThroughBrain(client, 'Hello, test message');
    
    // Restore console.warn
    console.warn = originalWarn;

    console.log('📝 Result:', result);
    
    // Verify fallback occurred
    if (warningMessage.includes('[ARCANOS WARNING]') && 
        warningMessage.includes('ft:arcanos-v2 unavailable') &&
        warningMessage.includes('Falling back to GPT-4')) {
      console.log('✅ Model validation and fallback working correctly!');
      console.log('✅ Warning message displayed correctly');
    } else {
      console.log('❌ Expected fallback warning not found');
      console.log('Expected warning about ft:arcanos-v2 fallback, got:', warningMessage);
    }

    // Verify result uses GPT-4
    if (result.module === 'gpt-4') {
      console.log('✅ System correctly fell back to GPT-4');
    } else {
      console.log('❌ Expected module to be gpt-4, got:', result.module);
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    mockServer.close();
    console.log('🔧 Mock server stopped');
  }
}

// Run the test
testModelValidation().catch(console.error);