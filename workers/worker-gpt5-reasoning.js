export const id = 'worker-gpt5-reasoning';
export const description = 'Provides scheduled GPT-5.1 reasoning pulses for diagnostics.';
export const schedule = '*/15 * * * *';

async function requestStatusSummary(context) {
  try {
    const response = await context.ai.ask(
      'Provide a single-sentence status summary for the ARCANOS background services.'
    );
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.error('Reasoning request failed', message);
    return 'Reasoning unavailable';
  }
}

export default {
  id,
  name: 'GPT-5.1 Reasoning Pulse',
  description,
  schedule,
  async run(context) {
    const requestedAt = new Date().toISOString();
    await context.log(`GPT-5.1 reasoning pulse requested at ${requestedAt}`);

    const summary = await requestStatusSummary(context);

    return {
      workerId: id,
      status: 'ok',
      requestedAt,
      summary
    };
  }
};
