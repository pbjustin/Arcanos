import { config } from 'dotenv';
import OpenAI from 'openai';

config();

async function testGPT5() {
  console.log('🔍 Testing GPT-5 API accessibility...');
  
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not found in environment');
    return false;
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  try {
    console.log('📡 Attempting GPT-5 API call...');
    
    const response = await client.chat.completions.create({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'You are a test assistant. Respond with "GPT-5 is working correctly" if you can process this request.' },
        { role: 'user', content: 'Test GPT-5 connectivity' }
      ],
      max_completion_tokens: 50,
      temperature: 0
    });

    const content = response.choices[0]?.message?.content;
    console.log('✅ GPT-5 Response:', content);
    console.log('📊 Model used:', response.model);
    console.log('🎯 Usage:', response.usage);
    
    return true;
  } catch (error) {
    console.error('❌ GPT-5 Error:', error.message);
    console.error('📋 Error details:', error.code || 'No error code');
    return false;
  }
}

testGPT5().then(success => {
  if (success) {
    console.log('🎉 GPT-5 test completed successfully!');
    process.exit(0);
  } else {
    console.log('💥 GPT-5 test failed!');
    process.exit(1);
  }
}).catch(err => {
  console.error('💥 Unexpected error:', err);
  process.exit(1);
});