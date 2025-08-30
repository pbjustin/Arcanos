const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = {
  route: '/echo',
  description: 'Echoes back input using OpenAI GPT',
  async handler(body) {
    const { prompt } = body;

    // Example OpenAI call (replace with GPT-4/5 if needed)
    const completion = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }]
    });

    return {
      input: prompt,
      output: completion.choices[0].message.content
    };
  }
};
