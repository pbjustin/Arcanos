const OpenAI = require("openai");

// Initialize OpenAI client using API key from environment
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Adapter to match expected interface with createChatCompletion method
module.exports = {
  createChatCompletion: async (params) => openai.chat.completions.create(params),
};
