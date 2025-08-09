import OpenAI from 'openai';
import { appendFileSync } from 'fs';
import { ensureLogDirectory, getGPT4TracePath, getAuditShadowPath } from '../utils/logPath.js';
import { validateAuditSafeOutput, createAuditSummary } from './auditSafe.js';
import { ensureShadowReady, disableShadowMode } from './shadowControl.js';

export type ShadowTag = 'content_generation' | 'agent_role_check';

async function routeToModule(client: OpenAI, tag: ShadowTag, content: string): Promise<string> {
  const systemPrompt =
    tag === 'content_generation'
      ? 'You are creative_architect, an advanced AI module for synthesizing content. Mirror the described ARCANOS event and respond.'
      : 'You are role_alignment_tracker, an advanced AI module monitoring role adherence and drift. Mirror the described ARCANOS event and respond.';

  const response = await client.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content }
    ],
    temperature: 0.2,
    max_tokens: 500
  });

  return response.choices[0]?.message?.content || '';
}

export async function mirrorDecisionEvent(
  client: OpenAI,
  taskId: string,
  event: string,
  original: string,
  tag: ShadowTag
): Promise<void> {
  if (!ensureShadowReady()) return;

  try {
    const shadowInput = `Event: ${event}\nTask ID: ${taskId}\nOriginal Data: ${original}`;
    const gpt4Output = await routeToModule(client, tag, shadowInput);

    ensureLogDirectory();
    const timestamp = new Date().toISOString();
    appendFileSync(
      getGPT4TracePath(),
      `${timestamp} | ${taskId} | ${event} | ${tag} | ${gpt4Output.replace(/\n/g, ' ')}\n`
    );

    const delta =
      original === gpt4Output
        ? 'MATCH'
        : `ARC: ${createAuditSummary(original)} | GPT4: ${createAuditSummary(gpt4Output)}`;

    let line = `${timestamp} | ${taskId} | ${event} | ${delta}`;
    if (!validateAuditSafeOutput(gpt4Output, { auditSafeMode: true })) {
      line += ' | REJECTED_AUDIT';
    }
    appendFileSync(getAuditShadowPath(), line + '\n');
  } catch (err) {
    ensureLogDirectory();
    const timestamp = new Date().toISOString();
    const msg = err instanceof Error ? err.message : 'Unknown error';
    appendFileSync(
      getAuditShadowPath(),
      `${timestamp} | ${taskId} | ${event} | FALLBACK:${msg}\n`
    );
    disableShadowMode(msg);
  }
}

