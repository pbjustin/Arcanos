const OpenAI = require('openai');

module.exports = async function fineTuneProcessor(task) {
  if (!task || typeof task !== 'object') throw new Error('Task object required');
  const { type, payload, taskId } = task;
  if (!type || typeof payload === 'undefined') {
    throw new Error('Invalid task format');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.FINE_TUNED_MODEL;
  if (!apiKey || !model) {
    throw new Error('Missing OpenAI configuration');
  }

  const promptMap = {
    audit: (p) => `Audit the following code and describe any issues:\n\n${p}`,
    score: (p) => `Provide a score from 1-10 for the following content:\n\n${p}`,
    summarize: (p) => `Summarize the following text:\n\n${p}`,
  };

  const builder = promptMap[type];
  if (!builder) throw new Error(`Unsupported task type: ${type}`);
  const prompt = builder(payload);

  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000,
    temperature: 0.3,
  });

  const output = completion.choices?.[0]?.message?.content?.trim() || '';
  return { taskId: taskId || null, output };
};
