import { Ajv } from 'ajv';
import {
  chatGptTutorInputSchema, chatGptTutorOutputSchema,
  type ChatGptTutorInput, type ChatGptTutorOutput,
} from '@arcanos/protocol';
import { runWithSessionContext } from '@platform/runtime/sessionContext.js';
import { classifyWritingPlaneInput } from '@platform/runtime/writingPlaneContract.js';
import { parseMemoryInspectionRequest } from '@services/memoryInspectionGuard.js';
import { hasUnsafeBlockingConditions } from '@services/safety/runtimeState.js';
import { hasChatGptTutorPermission, type ChatGptPrincipal } from './auth.js';

const ajv = new Ajv({ allErrors: false });
export const isTutorInput = ajv.compile<ChatGptTutorInput>(chatGptTutorInputSchema);
const isTutorOutput = ajv.compile<ChatGptTutorOutput>(chatGptTutorOutputSchema);

export class TutorPilotError extends Error {
  constructor(public readonly code: 'TUTOR_PERMISSION_DENIED' | 'TUTOR_INPUT_INVALID' | 'TUTOR_REQUEST_UNSUPPORTED' | 'TUTOR_UNAVAILABLE') {
    super(code);
  }
}

/** Authorization-preserving adapter: no dispatcher, module selector, jobs or session reads. */
export async function executeTutorPilot(principal: ChatGptPrincipal, input: unknown): Promise<ChatGptTutorOutput> {
  if (!hasChatGptTutorPermission(principal)) throw new TutorPilotError('TUTOR_PERMISSION_DENIED');
  if (hasUnsafeBlockingConditions()) throw new TutorPilotError('TUTOR_UNAVAILABLE');
  if (!isTutorInput(input)) throw new TutorPilotError('TUTOR_INPUT_INVALID');
  const classification = classifyWritingPlaneInput({
    body: { prompt: input.prompt }, promptText: input.prompt, requestedAction: 'query',
  });
  if (classification.plane === 'control' || parseMemoryInspectionRequest(input.prompt)) {
    throw new TutorPilotError('TUTOR_REQUEST_UNSUPPORTED');
  }
  return runWithSessionContext(undefined, async () => {
    const { ArcanosTutor } = await import('@services/arcanos-tutor.js');
    const result = await ArcanosTutor.actions.query({ prompt: input.prompt }, { isolated: true });
    const audit = result.audit_trace as { model?: { intake?: string }; instruction_module?: string };
    const generation = audit.instruction_module === 'exact_literal_shortcut'
      ? 'shortcut' : audit.model?.intake === 'mock' ? 'mock' : 'model';
    const output: ChatGptTutorOutput = {
      answer: result.arcanos_tutor,
      metadata: { module: 'ARCANOS:TUTOR', memory: 'unavailable', execution: 'synchronous', generation },
    };
    if (!isTutorOutput(output)) throw new TutorPilotError('TUTOR_UNAVAILABLE');
    return output;
  });
}
