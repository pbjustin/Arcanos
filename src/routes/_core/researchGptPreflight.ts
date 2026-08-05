import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { resolveDispatchLaneForRequest } from '@services/controlPlane/dispatchDagCompatibilityBoundary.js';
import { isRegisteredResearchGptId } from '@services/researchGptRouting.js';
import {
  buildResolvedGptDispatchBody,
} from '@shared/dispatch/universalDispatch.js';
import { normalizeGptRequestBody } from '@shared/gpt/gptIdempotency.js';
import { resolveGptModuleRequestedActionAlias } from '@shared/gpt/gptModuleAction.js';
import {
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION,
} from '@shared/gpt/gptJobResult.js';
import { resolveRequestedGptAction } from '@shared/gpt/gptRequestAction.js';
import { isDiagnosticRequest } from '@shared/http/diagnosticRequest.js';
import {
  buildResearchModulePreflightPayload,
  extractBoundedResearchDispatchPromptText,
  getResearchGptPromptPreflight,
  inspectBoundedResearchDispatchPromptText,
  inspectResearchPreAdmissionPromptText,
  isResearchRequestValidationError,
  normalizeResearchModulePayload,
  RESEARCH_ACTION_NAME,
  RESEARCH_TOPIC_MAX_LENGTH,
  ResearchRequestValidationError,
  setResearchGptPromptPreflight,
  snapshotResearchGptPreflightBody,
} from '@shared/researchRequest.js';

const DEFAULT_DISPATCH_GPT_ID = 'arcanos-core';
const canonicalResearchAdmissionAttempted = new WeakSet<object>();
const canonicalResearchValidationAttempted = new WeakSet<object>();
const dispatchResearchAdmissionAttempted = new WeakSet<object>();
const dispatchResearchValidationAttempted = new WeakSet<object>();

function asRequestRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
}

function ownDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function prepareDescriptorSafeCanonicalBody(req: Request): {
  normalizedBody: unknown;
  normalizedBodyRecord: Record<string, unknown> | null;
} {
  const bodySnapshot = snapshotResearchGptPreflightBody(req.body);
  const normalizedBodyRecord = normalizeGptRequestBody(bodySnapshot);
  const normalizedBody = normalizedBodyRecord ?? bodySnapshot;
  req.body = normalizedBody;
  return { normalizedBody, normalizedBodyRecord };
}

function resolveCanonicalRequestedAction(req: Request, body: unknown): string | null {
  return resolveRequestedGptAction({
    body,
    query: req.query as Record<string, unknown>,
    gptActionHeader: typeof req.header === 'function'
      ? req.header('x-gpt-action')
      : undefined,
    arcanosActionHeader: typeof req.header === 'function'
      ? req.header('x-arcanos-action')
      : undefined,
  });
}

function recordCanonicalInspectionFailure(
  req: Request,
  error: unknown,
  validationComplete: boolean,
): boolean {
  if (!isResearchRequestValidationError(error)) {
    return false;
  }

  // Keep later generic GPT helpers away from the invalid object. The typed
  // preflight result remains the source of the eventual validation response.
  req.body = {};
  setResearchGptPromptPreflight(req, {
    promptText: null,
    validationError: error,
    providerIntended: true,
    validationComplete,
  });
  return true;
}

/** Mirrors the top-level action that routeGptRequest ultimately consumes. */
function resolveEventualResearchAction(
  body: unknown,
  routeQueryDefaultsToRun: boolean,
): string {
  if (routeQueryDefaultsToRun) {
    return RESEARCH_ACTION_NAME;
  }

  const bodyRecord = asRequestRecord(body);
  const rawAction = bodyRecord ? ownDataProperty(bodyRecord, 'action') : undefined;
  if (typeof rawAction !== 'string' || rawAction.trim().length === 0) {
    return RESEARCH_ACTION_NAME;
  }

  return resolveGptModuleRequestedActionAlias(
    rawAction,
    [RESEARCH_ACTION_NAME],
  ) ?? RESEARCH_ACTION_NAME;
}

function recordResearchPromptPreflight(
  req: Request,
  body: unknown,
  validateRunPayload: boolean,
  payloadOverride?: unknown,
  promptTextOverride?: string | null,
  validationErrorOverride?: ResearchRequestValidationError | null,
): void {
  const promptText = promptTextOverride !== undefined
    ? promptTextOverride
    : extractBoundedResearchDispatchPromptText(body);
  const diagnosticRequest = isDiagnosticRequest(asRequestRecord(body), promptText);
  let validationError = diagnosticRequest ? null : validationErrorOverride ?? null;

  if (validateRunPayload && !diagnosticRequest && !validationError) {
    try {
      normalizeResearchModulePayload(
        payloadOverride ?? buildResearchModulePreflightPayload(body),
      );
    } catch (error: unknown) {
      if (!isResearchRequestValidationError(error)) {
        throw error;
      }
      validationError = error;
    }
  }

  setResearchGptPromptPreflight(req, {
    promptText,
    validationError,
    providerIntended: validateRunPayload && !diagnosticRequest,
    validationComplete: true,
  });
}

function prepareCanonicalRunPayload(
  req: Request,
  body: unknown,
  queryPromptFallbackEnabled: boolean,
): {
  payload: unknown;
  promptText: string | null;
  validationError: ResearchRequestValidationError | null;
} {
  let payload: unknown = {};
  const bodyInspection = inspectBoundedResearchDispatchPromptText(body);
  let promptText = bodyInspection.promptText;
  let payloadValidationError: ResearchRequestValidationError | null = null;
  try {
    payload = buildResearchModulePreflightPayload(body);
    normalizeResearchModulePayload(payload);
  } catch (error: unknown) {
    if (!isResearchRequestValidationError(error)) {
      throw error;
    }
    payloadValidationError = error;
  }

  if (!queryPromptFallbackEnabled) {
    return { payload, promptText, validationError: payloadValidationError };
  }

  if (bodyInspection.candidatePresent) {
    const promptValidationError = bodyInspection.overLimit
      ? new ResearchRequestValidationError(
          `Research topic must be no more than ${RESEARCH_TOPIC_MAX_LENGTH} JavaScript String.length units.`,
        )
      : null;
    return {
      payload,
      promptText,
      validationError: payloadValidationError ?? promptValidationError,
    };
  }

  const queryInspection = inspectBoundedResearchDispatchPromptText(req.query, {
    preserveOversizedBlank: true,
  });
  if (!queryInspection.candidatePresent) {
    return { payload, promptText, validationError: payloadValidationError };
  }

  promptText = queryInspection.promptText;
  const queryValidationError = queryInspection.overLimit
    ? new ResearchRequestValidationError(
        `Research topic must be no more than ${RESEARCH_TOPIC_MAX_LENGTH} JavaScript String.length units.`,
      )
    : null;
  if (
    !queryValidationError
    && queryInspection.promptText
    && payloadValidationError?.issue === 'topic_required'
  ) {
    payload = buildResearchModulePreflightPayload(body, queryInspection.promptText);
    payloadValidationError = null;
  }

  return {
    payload,
    promptText,
    validationError: payloadValidationError?.issue === 'topic_required'
      ? queryValidationError ?? payloadValidationError
      : payloadValidationError ?? queryValidationError,
  };
}

async function prepareCanonicalResearchAdmission(req: Request): Promise<void> {
  if (canonicalResearchAdmissionAttempted.has(req)) {
    return;
  }
  canonicalResearchAdmissionAttempted.add(req);

  if (!await isRegisteredResearchGptId(req.params.gptId)) {
    return;
  }

  let normalizedBody: unknown;
  try {
    ({ normalizedBody } = prepareDescriptorSafeCanonicalBody(req));
  } catch (error: unknown) {
    if (recordCanonicalInspectionFailure(req, error, false)) {
      return;
    }
    throw error;
  }

  const requestedAction = resolveCanonicalRequestedAction(req, normalizedBody);
  const queryAndWaitDefaultsToRun = requestedAction === GPT_QUERY_AND_WAIT_ACTION;
  const routeQueryDefaultsToRun = requestedAction === GPT_QUERY_ACTION
    || queryAndWaitDefaultsToRun;
  const eventualAction = resolveEventualResearchAction(
    normalizedBody,
    routeQueryDefaultsToRun,
  );
  const explicitDiagnosticRequest = isDiagnosticRequest(
    asRequestRecord(normalizedBody),
    null,
  );
  const promptInspection = inspectResearchPreAdmissionPromptText(normalizedBody);
  const diagnosticRequest = explicitDiagnosticRequest || isDiagnosticRequest(
    asRequestRecord(normalizedBody),
    promptInspection.promptText,
  );
  setResearchGptPromptPreflight(req, {
    promptText: promptInspection.promptText,
    validationError: null,
    providerIntended: requestedAction === GPT_QUERY_ACTION
      || requestedAction === GPT_QUERY_AND_WAIT_ACTION
      || (eventualAction === RESEARCH_ACTION_NAME && !diagnosticRequest),
    validationComplete: false,
  });
}

async function prepareCanonicalResearchPrompt(req: Request): Promise<void> {
  if (canonicalResearchValidationAttempted.has(req)) {
    return;
  }
  canonicalResearchValidationAttempted.add(req);

  if (!await isRegisteredResearchGptId(req.params.gptId)) {
    return;
  }

  const admissionPreflight = getResearchGptPromptPreflight(req);
  if (admissionPreflight?.validationError) {
    setResearchGptPromptPreflight(req, {
      ...admissionPreflight,
      validationComplete: true,
    });
    return;
  }

  let normalizedBody: unknown;
  let normalizedBodyRecord: Record<string, unknown> | null;
  try {
    ({ normalizedBody, normalizedBodyRecord } = prepareDescriptorSafeCanonicalBody(req));
  } catch (error: unknown) {
    if (recordCanonicalInspectionFailure(req, error, true)) {
      return;
    }
    throw error;
  }

  const requestedAction = resolveCanonicalRequestedAction(req, normalizedBody);
  const queryAndWaitDefaultsToRun = requestedAction === GPT_QUERY_AND_WAIT_ACTION;
  const routeQueryDefaultsToRun = requestedAction === GPT_QUERY_ACTION
    || queryAndWaitDefaultsToRun;
  const eventualAction = resolveEventualResearchAction(
    normalizedBody,
    routeQueryDefaultsToRun,
  );
  if (queryAndWaitDefaultsToRun && !normalizedBodyRecord) {
    setResearchGptPromptPreflight(req, {
      promptText: null,
      validationError: null,
      providerIntended: true,
      validationComplete: true,
    });
    return;
  }

  const explicitDiagnosticRequest = isDiagnosticRequest(
    asRequestRecord(normalizedBody),
    null,
  );
  const promptText = explicitDiagnosticRequest
    ? inspectResearchPreAdmissionPromptText(normalizedBody).promptText
    : extractBoundedResearchDispatchPromptText(normalizedBody);
  const diagnosticRequest = explicitDiagnosticRequest
    || isDiagnosticRequest(asRequestRecord(normalizedBody), promptText);
  if (eventualAction !== RESEARCH_ACTION_NAME && !diagnosticRequest) {
    return;
  }

  const preparedRun = eventualAction === RESEARCH_ACTION_NAME
    ? prepareCanonicalRunPayload(
        req,
        normalizedBody,
        requestedAction === GPT_QUERY_ACTION || queryAndWaitDefaultsToRun,
      )
    : null;

  recordResearchPromptPreflight(
    req,
    normalizedBody,
    eventualAction === RESEARCH_ACTION_NAME,
    preparedRun?.payload,
    preparedRun ? preparedRun.promptText : promptText,
    preparedRun?.validationError,
  );
}

async function prepareDispatchResearchAdmission(req: Request): Promise<void> {
  if (dispatchResearchAdmissionAttempted.has(req)) {
    return;
  }
  dispatchResearchAdmissionAttempted.add(req);

  const resolution = resolveDispatchLaneForRequest(req);
  if (resolution.lane !== 'gpt') {
    return;
  }

  const effectiveBody = buildResolvedGptDispatchBody(resolution.input);
  const eventualAction = resolveEventualResearchAction(effectiveBody, false);
  if (!await isRegisteredResearchGptId(
    resolution.input.gptId ?? DEFAULT_DISPATCH_GPT_ID,
  )) {
    return;
  }

  const explicitDiagnosticRequest = isDiagnosticRequest(
    asRequestRecord(effectiveBody),
    null,
  );
  const promptInspection = inspectResearchPreAdmissionPromptText(effectiveBody);
  const diagnosticRequest = explicitDiagnosticRequest || isDiagnosticRequest(
    asRequestRecord(effectiveBody),
    promptInspection.promptText,
  );
  setResearchGptPromptPreflight(req, {
    promptText: promptInspection.promptText,
    validationError: null,
    providerIntended: eventualAction === RESEARCH_ACTION_NAME && !diagnosticRequest,
    validationComplete: false,
  });
}

async function prepareDispatchResearchPrompt(req: Request): Promise<void> {
  if (dispatchResearchValidationAttempted.has(req)) {
    return;
  }
  dispatchResearchValidationAttempted.add(req);

  const resolution = resolveDispatchLaneForRequest(req);
  if (resolution.lane !== 'gpt') {
    return;
  }

  const effectiveBody = buildResolvedGptDispatchBody(resolution.input);
  const eventualAction = resolveEventualResearchAction(effectiveBody, false);
  if (!await isRegisteredResearchGptId(
    resolution.input.gptId ?? DEFAULT_DISPATCH_GPT_ID,
  )) {
    return;
  }

  const explicitDiagnosticRequest = isDiagnosticRequest(
    asRequestRecord(effectiveBody),
    null,
  );
  const promptText = explicitDiagnosticRequest
    ? inspectResearchPreAdmissionPromptText(effectiveBody).promptText
    : extractBoundedResearchDispatchPromptText(effectiveBody);
  const diagnosticRequest = explicitDiagnosticRequest
    || isDiagnosticRequest(asRequestRecord(effectiveBody), promptText);
  if (eventualAction !== RESEARCH_ACTION_NAME && !diagnosticRequest) {
    return;
  }

  recordResearchPromptPreflight(
    req,
    effectiveBody,
    eventualAction === RESEARCH_ACTION_NAME,
    undefined,
    promptText,
  );
}

function runPreflight(
  work: () => Promise<void>,
  next: NextFunction,
): void {
  void work().then(() => next(), next);
}

export const canonicalResearchGptPreflightBoundary: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  runPreflight(() => prepareCanonicalResearchPrompt(req), next);
};

export const canonicalResearchGptAdmissionBoundary: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  runPreflight(() => prepareCanonicalResearchAdmission(req), next);
};

export const dispatchResearchGptPreflightBoundary: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  runPreflight(() => prepareDispatchResearchPrompt(req), next);
};

export const dispatchResearchGptAdmissionBoundary: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  runPreflight(() => prepareDispatchResearchAdmission(req), next);
};
