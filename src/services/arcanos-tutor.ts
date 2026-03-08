import tutorLogic, { type TutorQuery } from "@core/logic/tutor-logic.js";
import { buildHrcMemoryInspectionGuard, withHRC } from './hrcWrapper.js';

export const ArcanosTutor = {
  name: 'ARCANOS:TUTOR',
  description:
    'Professional tutoring kernel with dynamic schema binding, modular instruction, audit traceability, and feedback loops.',
  gptIds: ['arcanos-tutor', 'tutor'],
  actions: {
    async query(payload: TutorQuery) {
      const result = await tutorLogic.dispatch(payload);
      const prompt = extractTutorPrompt(payload);
      const sessionId = extractTutorSessionId(payload);
      const hrcGuard = buildHrcMemoryInspectionGuard({ prompt, sessionId });
      const guardedResult = hrcGuard
        ? {
            ...result,
            arcanos_tutor: hrcGuard.text,
            audit_trace: {
              ...(result.audit_trace as Record<string, unknown>),
              hrc_guard: {
                applied: true,
                reason: hrcGuard.reason
              }
            }
          }
        : result;

      return withHRC(guardedResult, r => r.arcanos_tutor);
    },
  },
};

export default ArcanosTutor;

/**
 * Extract the raw operator prompt from tutor payload aliases.
 * Inputs/outputs: tutor payload -> primary prompt string or serialized fallback.
 * Edge cases: nested payload objects are inspected before falling back to JSON serialization.
 */
function extractTutorPrompt(payload: TutorQuery): string {
  for (const candidate of [
    readStringField(payload, 'prompt'),
    readStringField(payload, 'message'),
    readStringField(payload, 'query'),
    readStringField(payload, 'text'),
    readNestedStringField(payload.payload, 'prompt'),
    readNestedStringField(payload.payload, 'message'),
    readNestedStringField(payload.payload, 'query'),
    readNestedStringField(payload.payload, 'text'),
    readNestedStringField(payload.payload, 'topic'),
    readNestedStringField(payload.payload, 'entry'),
    readNestedStringField(payload.payload, 'flow')
  ]) {
    if (candidate) {
      return candidate;
    }
  }

  return safeSerializeTutorPayload(payload);
}

/**
 * Extract the transport session id from tutor payload aliases when present.
 * Inputs/outputs: tutor payload -> session id string or undefined.
 * Edge cases: missing/non-string values resolve to undefined.
 */
function extractTutorSessionId(payload: TutorQuery): string | undefined {
  return readStringField(payload, 'sessionId') ?? readNestedStringField(payload.payload, 'sessionId');
}

function readStringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNestedStringField(source: unknown, key: string): string | undefined {
  return readStringField(source, key);
}

function safeSerializeTutorPayload(payload: TutorQuery): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return '[unserializable tutor payload]';
  }
}
