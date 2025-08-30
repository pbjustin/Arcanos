const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Allow configuring model via environment with fallback to primary fine-tune
const DEFAULT_MODEL =
  process.env.OPENAI_MODEL || 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote';

module.exports = {
  route: '/echo',
  description: 'Echoes back input using OpenAI GPT',
  async handler(body) {
    const { prompt } = body;

    // Example OpenAI call (replace with GPT-4/5 if needed)
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }]
    });

    return {
      input: prompt,
      output: completion.choices[0].message.content
    };
  }
};
