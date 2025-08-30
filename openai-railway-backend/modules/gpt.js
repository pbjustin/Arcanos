const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Allow configuring the model via environment variable while defaulting to the
// project's main fine‑tuned model.
const DEFAULT_MODEL =
  process.env.OPENAI_MODEL || 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote';

module.exports = {
  route: '/gpt',
  description: 'OpenAI GPT Query Module',

  async handler(payload = {}) {
    const { prompt, messages, model, ...params } = payload;
    const finalMessages = messages ||
      (prompt ? [{ role: 'user', content: prompt }] : null);
    if (!finalMessages) throw new Error('Missing prompt or messages');

    try {
      const completion = await client.chat.completions.create({
        model: model || DEFAULT_MODEL,
        messages: finalMessages,
        ...params
      });

      return {
        input: finalMessages,
        output: completion.choices[0]?.message?.content || ''
      };
    } catch (err) {
      return { error: err.message };
    }
  },

  async handle(payload) {
    return this.handler(payload);
  }
};
