import {
  classifyWritingPlaneInput,
  isDirectControlPlaneKind,
} from '@platform/runtime/writingPlaneContract.js';
import { type NaturalLanguageJobLookupIntent } from '@shared/gpt/naturalLanguageJobLookup.js';

export type GptDirectControlKind =
  | 'diagnostics'
  | 'job_result'
  | 'job_status'
  | 'system_state';

export type GptRejectedControlKind =
  | 'dag_control'
  | 'job_lookup'
  | 'mcp_control'
  | 'runtime_inspection';

export type GptPlaneClassification =
  | {
      plane: 'writing';
      kind: 'writing';
      action: string | null;
      reason: string;
    }
  | {
      plane: 'control';
      kind: GptDirectControlKind;
      action: string;
      reason: string;
    }
  | {
      plane: 'reject';
      kind: GptRejectedControlKind;
      action: string;
      reason: string;
      errorCode: string;
      message: string;
      canonical: Record<string, string | null>;
      jobLookup?: NaturalLanguageJobLookupIntent;
    };

export type GptWritingPlaneClassification = Extract<
  GptPlaneClassification,
  { plane: 'writing' }
>;

export function classifyGptRequestPlane(input: {
  body: unknown;
  promptText: string | null;
  requestedAction: string | null;
}): GptPlaneClassification {
  const classification = classifyWritingPlaneInput(input);
  if (classification.plane === 'writing') {
    return classification;
  }

  if (isDirectControlPlaneKind(classification.kind)) {
    return {
      plane: 'control',
      kind: classification.kind,
      action: classification.action,
      reason: classification.reason,
    };
  }

  return {
    plane: 'reject',
    kind: classification.kind,
    action: classification.action,
    reason: classification.reason,
    errorCode: classification.errorCode,
    message: classification.message,
    canonical: classification.canonical,
    ...(classification.jobLookup ? { jobLookup: classification.jobLookup } : {}),
  };
}

export function assertWritingPlaneClassification(
  classification: GptPlaneClassification
): asserts classification is GptWritingPlaneClassification {
  if (classification.plane !== 'writing') {
    throw new Error(
      `Expected writing-plane classification, received ${classification.plane}:${classification.kind}.`
    );
  }
}
