require('dotenv').config();
const OpenAI = require('openai');
const { log } = require('./utils/logger.cjs');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function runAI(payload) {
  try {
    log('🔍 Calling OpenAI...');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: payload.messages || [{ role: 'user', content: 'Hello!' }],
      temperature: 0.7,
    });
    log('✅ OpenAI responded');
    return completion;
  } catch (err) {
    log('❌ OpenAI Error: ' + err.message);
    return { error: err.message };
  }
}

module.exports = { runAI };