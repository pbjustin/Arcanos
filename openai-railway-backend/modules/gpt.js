const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = {
  route: '/gpt',
  description: 'OpenAI GPT Query Module',
  async handler(payload) {
    if (!payload.prompt) throw new Error('Missing prompt');
    const completion = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: payload.prompt }]
    });
    return {
      input: payload.prompt,
      output: completion.choices[0].message.content
    };
  },
  async handle(payload) {
    return this.handler(payload);
  }
};
