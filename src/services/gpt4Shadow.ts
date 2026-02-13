import type OpenAI from 'openai';
import { appendFileSync } from 'fs';
import { ensureLogDirectory, getGPT4TracePath, getAuditShadowPath } from "@shared/logPath.js";
import { validateAuditSafeOutput, createAuditSummary } from './auditSafe.js';
import { ensureShadowReady, disableShadowMode } from './shadowControl.js';
import { getTokenParameter } from "@shared/tokenParameterHelper.js";
import type { OpenAIAdapter } from "@core/adapters/openai.adapter.js";
import type { ChatCompletion } from './openai/types.js';
import { resolveErrorMessage } from "@core/lib/errors/index.js";

export type ShadowTag = 'content_generation' | 'agent_role_check';

async function routeToModule(clientOrAdapter: OpenAI | OpenAIAdapter, tag: ShadowTag, content: string): Promise<string> {
  const systemPrompt =
    tag === 'content_generation'
      ? 'You are creative_architect, an advanced AI module for synthesizing content. Mirror the described ARCANOS event and respond.'
      : 'You are role_alignment_tracker, an advanced AI module monitoring role adherence and drift. Mirror the described ARCANOS event and respond.';

  const model = 'gpt-4o';
  const tokenParams = getTokenParameter(model, 500);
  
  // Support both adapter and legacy client
  const response = 'chat' in clientOrAdapter && typeof clientOrAdapter.chat === 'object'
    ? await clientOrAdapter.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content }
        ],
        temperature: 0.2,
        ...tokenParams
      })
    : await (clientOrAdapter as OpenAI).chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content }
        ],
        temperature: 0.2,
        ...tokenParams
      });

  // Handle both ChatCompletion and Stream types
  if (response && typeof response === 'object' && 'choices' in response) {
    return (response as ChatCompletion).choices[0]?.message?.content || '';
  }
  return '';
}

export async function mirrorDecisionEvent(
  clientOrAdapter: OpenAI | OpenAIAdapter,
  taskId: string,
  event: string,
  original: string,
  tag: ShadowTag
): Promise<void> {
  if (!ensureShadowReady()) return;

  try {
    const shadowInput = `Event: ${event}\nTask ID: ${taskId}\nOriginal Data: ${original}`;
    const gpt4Output = await routeToModule(clientOrAdapter, tag, shadowInput);

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
    const msg = resolveErrorMessage(err);
    appendFileSync(
      getAuditShadowPath(),
      `${timestamp} | ${taskId} | ${event} | FALLBACK:${msg}\n`
    );
    disableShadowMode(msg);
  }
}

