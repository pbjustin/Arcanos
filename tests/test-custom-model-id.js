import { createServer } from 'http';
import { URL } from 'url';

/**
 * Test custom MODEL_ID environment variable support
 */

// Mock OpenAI API server
function createMockOpenAIServerCustomModel() {
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
      
      if (modelId === 'ft:my-custom-model') {
        // Simulate custom model IS available
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'ft:my-custom-model',
          object: 'model',
          created: 1687882411,
          owned_by: 'user-456'
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

async function testCustomModelId() {
  console.log('🧪 Starting custom MODEL_ID test...');
  
  // Start mock OpenAI server
  const mockServer = createMockOpenAIServerCustomModel();
  await new Promise(resolve => mockServer.listen(8890, resolve));
  console.log('🔧 Mock OpenAI server started on port 8890');

  try {
    // Test with custom MODEL_ID
    process.env.OPENAI_BASE_URL = 'http://localhost:8890/v1';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MODEL_ID = 'ft:my-custom-model';

    // Import trinity module (this will use the environment variables)
    const { runThroughBrain } = await import('../dist/logic/trinity.js');
    const OpenAI = (await import('openai')).default;
    
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL
    });

    console.log('🧠 Testing custom MODEL_ID usage...');
    
    // Run trinity brain (should use ft:my-custom-model)
    const result = await runThroughBrain(client, 'Hello, test message');
    
    console.log('📝 Result:', result);
    
    // Verify result uses custom model
    if (result.module === 'ft:my-custom-model') {
      console.log('✅ System correctly used the custom MODEL_ID');
    } else {
      console.log('❌ Expected module to be ft:my-custom-model, got:', result.module);
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    mockServer.close();
    console.log('🔧 Mock server stopped');
  }
}

// Run the test
testCustomModelId().catch(console.error);