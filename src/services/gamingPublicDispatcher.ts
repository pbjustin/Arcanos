import {
  parsePublicGamingQueryRequest,
  type GamingMode,
  type PublicGamingRequestValidationError,
  type ValidatedPublicGamingQueryRequest
} from '@services/gamingModes.js';
import { isRecord } from '@shared/typeGuards.js';

export type PublicArcanosAction = 'query' | 'canary';

export type ArcanosRequestIntent =
  | 'gameplay_guide'
  | 'gameplay_build'
  | 'gameplay_meta'
  | 'public_canary'
  | 'integration_status'
  | 'unsupported';

export type ValidatedPublicGamingCanaryRequest = {
  action: 'canary';
  payload: {
    scope: 'public_pipeline';
  };
};

export type ValidatedPublicGamingActionRequest =
  | ValidatedPublicGamingQueryRequest
  | ValidatedPublicGamingCanaryRequest;

type GameplayIntent = 'gameplay_guide' | 'gameplay_build' | 'gameplay_meta';

export type PublicGamingDispatchDecision =
  | {
      ok: true;
      action: 'query';
      intent: GameplayIntent;
      mode: GamingMode;
      request: ValidatedPublicGamingQueryRequest;
    }
  | {
      ok: true;
      action: 'canary';
      intent: 'public_canary';
      mode: null;
      request: ValidatedPublicGamingCanaryRequest;
    }
  | {
      ok: false;
      action: 'query';
      intent: 'integration_status';
      mode: GamingMode;
      error: PublicGamingRequestValidationError;
    }
  | {
      ok: false;
      action: PublicArcanosAction | 'unsupported';
      intent: 'unsupported';
      mode: null;
      error: PublicGamingRequestValidationError;
    };

export const OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE = 'OPERATIONAL_REQUEST_NOT_GAMEPLAY';
export const OPERATIONAL_REQUEST_NOT_GAMEPLAY_MESSAGE =
  'This request asks about the public integration rather than gameplay. Use the public canary operation.';

const OPERATIONAL_TARGET_FOLLOWER = String.raw`(?=\s*(?:$|[.!?,;:]|(?:and\s+(?:then|see|check|verify|confirm)|before|after|then|health|status|availability|connectivity|logs?|working|reachable|responding|healthy|live|up|running|deployed|implemented|configured|connected|available)\b|(?:is|are|was|were)\s+(?:working|reachable|responding|healthy|live|up|running|deployed|implemented|configured|connected|available)\b|(?:has|have|had)\s+been\s+(?:implemented|deployed|configured|connected)\b))`;
const DIRECT_OPERATIONAL_TARGET_PATTERN = new RegExp(
  String.raw`\b(?:reach|ping|probe|diagnose|inspect)\b[^.!?\n]{0,48}\b(?:my|our|the|this|your)?\s*(?:arcanos\s+)?(?:backend|api|integration|deployment|service|endpoint|public(?:\s+action)?\s+pipeline|railway(?!\s+empire\b))\b${OPERATIONAL_TARGET_FOLLOWER}`,
  'iu'
);
const SHORT_SERVER_OPERATIONAL_PATTERN =
  /^(?:please\s+)?(?:inspect|check|verify|test|probe)\s+(?:whether\s+)?(?:my|our|the|this|your)?\s*server(?:\s+(?:health|status|availability|connectivity))?[.!?]?$/iu;
const SHORT_SERVER_STATUS_PATTERN =
  /^(?:is|are|was|were)\s+(?:my|our|the|this|your)\s+server\s+(?:working|reachable|responding|healthy|live|up|running|connected)[.!?]?$/iu;
const VERIFY_OPERATIONAL_TARGET_PATTERN = new RegExp(
  String.raw`\b(?:check|verify|validate|confirm|test)\b[^.!?\n]{0,64}\b(?:backend|api|integration|deployment|endpoint|public(?:\s+action)?\s+pipeline|custom\s+gpt\s+action|arcanos\s+action|railway(?!\s+empire\b))\b${OPERATIONAL_TARGET_FOLLOWER}`,
  'iu'
);
const ACTION_STATUS_PATTERN =
  /\b(?:check|verify|validate|confirm|test)\b[^.!?\n]{0,48}\b(?:the\s+)?action\b[^.!?\n]{0,32}\b(?:implemented|working|reachable|configured|connected)\b/iu;
const OPERATIONAL_STATUS_PATTERN =
  /\b(?:is|are|was|were)\s+(?:my|our|the|this|your)\s+(?:arcanos\s+)?(?:backend|api|integration|deployment|service|endpoint|public(?:\s+action)?\s+pipeline)\b[^.!?\n]{0,40}\b(?:working|reachable|responding|healthy|live|up|running|deployed|implemented|configured|connected)\b/iu;
const OPERATIONAL_REACH_PATTERN =
  /\b(?:did|does|has|can)\s+(?:this|it|the\s+request|my\s+request|the\s+action)\s+(?:reach|hit|call|contact)\b[^.!?\n]{0,32}\b(?:railway(?!\s+empire\b)|backend|api|service|deployment|endpoint)\b/iu;
const OPERATIONAL_STATUS_TARGET = String.raw`(?:(?:my|our|the|this|your)\s+)?(?:(?:arcanos\s+)?(?:backend|api|integration|deployment|service|endpoint)|server|(?:arcanos|custom\s+gpt)\s+action|public(?:\s+action)?\s+pipeline|railway)`;
const OPERATIONAL_STATE = String.raw`(?:working|reachable|responding|healthy|live|up|running|deployed|implemented|configured|connected|available|down|offline)`;
const OPERATIONAL_PAST_STATE = String.raw`(?:implemented|deployed|configured|connected)`;
const OPERATIONAL_STATUS_PREAMBLE = String.raw`(?:(?:(?:please\s+)?(?:check|verify|validate|confirm|test)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?(?:check|verify|validate|confirm|test|see|tell\s+me)\s+|(?:please\s+)?tell\s+me\s+)(?:if|whether)\s+)?`;
const EXPLICIT_OPERATIONAL_STATUS_PATTERN = new RegExp(
  String.raw`^${OPERATIONAL_STATUS_PREAMBLE}(?:(?:is|are|was|were)\s+${OPERATIONAL_STATUS_TARGET}\s+${OPERATIONAL_STATE}|(?:has|have|had)\s+${OPERATIONAL_STATUS_TARGET}\s+been\s+${OPERATIONAL_PAST_STATE}|(?:do|does|did)\s+${OPERATIONAL_STATUS_TARGET}\s+(?:work|respond|run|connect)|(?:can|could)\s+${OPERATIONAL_STATUS_TARGET}\s+be\s+(?:reached|contacted|called|accessed)|(?:why\s+)?(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|is\s+not|are\s+not|was\s+not|were\s+not)\s+${OPERATIONAL_STATUS_TARGET}\s+${OPERATIONAL_STATE}|${OPERATIONAL_STATUS_TARGET}\s+(?:(?:is|are|was|were)\s+${OPERATIONAL_STATE}|(?:has|have|had)\s+been\s+${OPERATIONAL_PAST_STATE}))(?:\s+correctly)?[.!?]?$`,
  'iu'
);

function normalizeOperationalPrompt(prompt: string): string {
  return prompt
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function isClearlyOperationalGamingPrompt(prompt: string): boolean {
  const normalizedPrompt = normalizeOperationalPrompt(prompt);
  if (/^ping[.!?]?$/iu.test(normalizedPrompt)) {
    return true;
  }

  return DIRECT_OPERATIONAL_TARGET_PATTERN.test(normalizedPrompt)
    || SHORT_SERVER_OPERATIONAL_PATTERN.test(normalizedPrompt)
    || SHORT_SERVER_STATUS_PATTERN.test(normalizedPrompt)
    || VERIFY_OPERATIONAL_TARGET_PATTERN.test(normalizedPrompt)
    || ACTION_STATUS_PATTERN.test(normalizedPrompt)
    || OPERATIONAL_STATUS_PATTERN.test(normalizedPrompt)
    || OPERATIONAL_REACH_PATTERN.test(normalizedPrompt)
    || EXPLICIT_OPERATIONAL_STATUS_PATTERN.test(normalizedPrompt);
}

export function resolveLiteralPublicGamingAction(body: unknown): PublicArcanosAction | null {
  if (!isRecord(body)) {
    return null;
  }

  return body.action === 'query' || body.action === 'canary' ? body.action : null;
}

function validatePublicGamingCanaryRequest(
  body: unknown
): ValidatedPublicGamingCanaryRequest | null {
  if (!isRecord(body) || Object.keys(body).length !== 2) {
    return null;
  }
  if (body.action !== 'canary' || !isRecord(body.payload)) {
    return null;
  }
  if (Object.keys(body.payload).length !== 1 || body.payload.scope !== 'public_pipeline') {
    return null;
  }

  return {
    action: 'canary',
    payload: { scope: 'public_pipeline' }
  };
}

function resolveGameplayIntent(mode: GamingMode): GameplayIntent {
  return `gameplay_${mode}`;
}

function unsupportedDecision(
  body: unknown,
  error: PublicGamingRequestValidationError
): PublicGamingDispatchDecision {
  return {
    ok: false,
    action: resolveLiteralPublicGamingAction(body) ?? 'unsupported',
    intent: 'unsupported',
    mode: null,
    error
  };
}

export function dispatchPublicGamingRequest(
  body: unknown,
  expectedAction: PublicArcanosAction
): PublicGamingDispatchDecision {
  if (expectedAction === 'canary') {
    const request = validatePublicGamingCanaryRequest(body);
    return request
      ? {
          ok: true,
          action: 'canary',
          intent: 'public_canary',
          mode: null,
          request
        }
      : unsupportedDecision(body, {
          code: 'BAD_REQUEST',
          message: "Public canary requests require action 'canary' and scope 'public_pipeline'."
        });
  }

  const validation = parsePublicGamingQueryRequest(body);
  if (!validation.ok) {
    return unsupportedDecision(body, validation.error);
  }

  const { mode, prompt } = validation.value.payload;
  if (isClearlyOperationalGamingPrompt(prompt)) {
    return {
      ok: false,
      action: 'query',
      intent: 'integration_status',
      mode,
      error: {
        code: OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE,
        message: OPERATIONAL_REQUEST_NOT_GAMEPLAY_MESSAGE
      }
    };
  }

  return {
    ok: true,
    action: 'query',
    intent: resolveGameplayIntent(mode),
    mode,
    request: validation.value
  };
}
