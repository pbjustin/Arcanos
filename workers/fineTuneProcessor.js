const OpenAI = require('openai');

function buildPrompt(task) {
  switch (task.type) {
    case 'audit':
      return `Audit this using CLEAR 2.0:\n\n${task.payload}`;
    case 'score':
      return `Score this logic:\n\n${task.payload}`;
    case 'summarize':
      return `Summarize the following:\n\n${task.payload}`;
    default:
      return `Process this:\n\n${task.payload}`;
  }
}

module.exports = async function fineTuneProcessor(task) {
  if (!task || !task.type || !task.payload) {
    throw new Error('task.type and task.payload are required');
  }

  const prompt = buildPrompt(task);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (!process.env.FINE_TUNED_MODEL) {
    throw new Error('FINE_TUNED_MODEL environment variable not set');
  }

  const completion = await openai.chat.completions.create({
    model: process.env.FINE_TUNED_MODEL,
    messages: [{ role: 'user', content: prompt }]
  });

  const output = completion.choices?.[0]?.message?.content || '';
  const taskId = task.id || task.taskId || Date.now();

  const result = { taskId, output };
  console.log('[fineTuneProcessor]', result);
  return result;
};
