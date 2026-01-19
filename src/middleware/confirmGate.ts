import { Request, Response, NextFunction } from 'express';
import {
  createConfirmationChallenge,
  getChallengeTtlMs,
  verifyConfirmationChallenge,
} from './confirmationChallengeStore.js';
import { getDefaultModel } from '../services/openai/credentialProvider.js';

export interface ConfirmationContext {
  confirmationStatus: string;
  gptId?: string;
  manualConfirmation: boolean;
  usedChallengeToken: boolean;
  isTrustedGpt: boolean;
  automationSecretApproved: boolean;
  allowAllOverride: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    confirmationContext?: ConfirmationContext;
  }
}

/**
 * ConfirmGate Middleware - OpenAI Terms of Service Compliance
 * 
 * Ensures all sensitive API endpoints require explicit user confirmation
 * before executing any logic. This prevents automatic GPT actions without
 * user consent, maintaining compliance with OpenAI's Terms of Service.
 * 
 * Requires explicit confirmation headers (`x-confirmed: yes` for manual approval or
 * `x-confirmed: token:<challengeId>` when responding to a pending confirmation
 * challenge) for the request to proceed unless a trusted GPT ID bypasses the gate.
 */
function isFineTunedModelIdentifier(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.startsWith('ft:');
}

function collectFineTunedAutomationIds(): string[] {
  const candidates = [
    process.env.FINE_TUNED_AUTOMATION_GPT_ID,
    process.env.FINETUNED_AUTOMATION_GPT_ID,
    process.env.FINETUNED_MODEL_ID,
    process.env.FINE_TUNED_MODEL_ID,
    process.env.OPENAI_MODEL,
    process.env.RAILWAY_OPENAI_MODEL,
    process.env.AI_MODEL,
    getDefaultModel()
  ];

  const fineTunedIds = new Set<string>();
  for (const candidate of candidates) {
    if (isFineTunedModelIdentifier(candidate)) {
      fineTunedIds.add(candidate.trim());
    }
  }

  return Array.from(fineTunedIds);
}

const trustedGptIds = new Set(
  (process.env.TRUSTED_GPT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

const implicitlyTrustedFineTunedIds = collectFineTunedAutomationIds();
implicitlyTrustedFineTunedIds.forEach((id) => trustedGptIds.add(id));

const wildcardTrusted = trustedGptIds.has('*');
const allowAllGpts = wildcardTrusted || process.env.ALLOW_ALL_GPTS === 'true';

const confirmationTokenPrefix = 'token:';
const automationBypassSecret = (process.env.ARCANOS_AUTOMATION_SECRET || '').trim();
const automationBypassHeader = (process.env.ARCANOS_AUTOMATION_HEADER || 'x-arcanos-automation').toLowerCase();
const automationBypassEnabled = Boolean(automationBypassSecret);

if (allowAllGpts) {
  console.log('[🛡️ CONFIRM-GATE] Allow-all GPT mode enabled - confirmation header optional for GPT requests');
}

if (implicitlyTrustedFineTunedIds.length > 0) {
  console.log(
    `[🧠 CONFIRM-GATE] Auto-trusting fine-tuned model identifiers for autonomous access: ${implicitlyTrustedFineTunedIds.join(', ')}`,
  );
}

if (automationBypassEnabled) {
  console.log(
    `[🤖 CONFIRM-GATE] Automation secret enabled - requests with header "${automationBypassHeader}" can self-approve when the secret matches.`,
  );
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function maskConfirmationHeader(value: string | undefined): string {
  if (!value) {
    return 'none';
  }

  return value.toLowerCase().startsWith(confirmationTokenPrefix) ? `${confirmationTokenPrefix}***` : value;
}

export function confirmGate(req: Request, res: Response, next: NextFunction): void {
  const confirmationHeader = normalizeHeaderValue(req.headers['x-confirmed']);
  const gptIdHeader = normalizeHeaderValue(req.headers['x-gpt-id'] as string | string[] | undefined);
  const gptIdFromBody = typeof req.body?.gptId === 'string' ? req.body.gptId : undefined;
  const gptId = gptIdHeader || gptIdFromBody;
  const isTrustedGpt = gptId ? trustedGptIds.has(gptId) : false;
  const automationHeaderValue = automationBypassEnabled
    ? normalizeHeaderValue(req.headers[automationBypassHeader] as string | string[] | undefined)
    : undefined;
  const automationBypassApproved = Boolean(
    automationBypassEnabled && automationHeaderValue && automationHeaderValue === automationBypassSecret,
  );
  const confirmationMode = allowAllGpts ? 'allow-all' : 'header';
  const normalizedConfirmation = confirmationHeader?.toString().trim();
  const confirmationHeaderLower = normalizedConfirmation?.toLowerCase();
  const manualConfirmation = confirmationHeaderLower === 'yes';
  const providedToken =
    normalizedConfirmation && confirmationHeaderLower?.startsWith(confirmationTokenPrefix)
      ? normalizedConfirmation.slice(confirmationTokenPrefix.length).trim()
      : undefined;

  let hasValidToken = false;
  if (!allowAllGpts && providedToken) {
    hasValidToken = verifyConfirmationChallenge(providedToken, req.method, req.path);
  }

  // Log the request for audit purposes
  console.log(
    `[🛡️ CONFIRM-GATE] ${req.method} ${req.path} - Confirmation: ${maskConfirmationHeader(confirmationHeader)} - GPTID: ${
      gptId || 'none'
    } - Mode: ${confirmationMode} - Automation: ${automationBypassApproved ? 'trusted' : 'none'}`,
  );

  // Check if user has explicitly confirmed the action
  if (!manualConfirmation && !hasValidToken && !isTrustedGpt && !automationBypassApproved && !allowAllGpts) {
    const challenge = createConfirmationChallenge(req.method, req.path, gptId || null);
    const tokenStatus = providedToken ? 'invalid' : 'missing';

    res.setHeader('x-confirmation-status', 'pending');
    res.setHeader('x-confirmation-challenge', challenge.id);

    console.log(
      `[❌ CONFIRM-GATE] Request blocked - confirmation ${tokenStatus}. GPTID: ${gptId || 'none'} - Challenge: ${challenge.id}`,
    );

    const confirmationInstructions = [
      'Inform the operator that this action is blocked until they explicitly approve it.',
      `If approved, resend the request with the header: x-confirmed: ${confirmationTokenPrefix}${challenge.id}.`,
      'Trusted automations can bypass manual review by registering their GPT ID in the TRUSTED_GPT_IDS environment variable.',
      automationBypassEnabled
        ? `Backend automations can also send ${automationBypassHeader}: <secret> when ARC automation is configured.`
        : undefined,
    ].filter((value): value is string => Boolean(value));

    res.status(403).json({
      error: 'Confirmation required',
      message:
        'This endpoint requires explicit human approval. Ask the operator to confirm the action before retrying.',
      code: 'CONFIRMATION_REQUIRED',
      endpoint: req.path,
      method: req.method,
      gptId: gptId || null,
      confirmationRequired: true,
      confirmationStatus: 'pending',
      confirmationChallenge: {
        id: challenge.id,
        issuedAt: new Date(challenge.issuedAt).toISOString(),
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        ttlMs: getChallengeTtlMs(),
        instructions: confirmationInstructions,
        gptIdTrusted: isTrustedGpt,
        allowedGptIds: Array.from(trustedGptIds),
        providedTokenStatus: tokenStatus,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const confirmationStatus = allowAllGpts
    ? 'auto-allowed'
    : hasValidToken
    ? 'challenge-token'
    : automationBypassApproved
    ? 'automation-secret'
    : isTrustedGpt
    ? 'trusted-gpt'
    : 'confirmed';
  res.setHeader('x-confirmation-status', confirmationStatus);
  req.confirmationContext = {
    confirmationStatus,
    gptId: gptId || undefined,
    manualConfirmation,
    usedChallengeToken: hasValidToken,
    isTrustedGpt,
    automationSecretApproved: automationBypassApproved,
    allowAllOverride: allowAllGpts,
  };
  console.log(`[✅ CONFIRM-GATE] Request confirmed - proceeding with execution (${confirmationStatus})`);
  next();
}

export const isAllowAllGptsEnabled = (): boolean => allowAllGpts;

export const getConfirmGateConfiguration = () => ({
  allowAllGpts,
  trustedGptIds: Array.from(trustedGptIds),
  requiresHeader: !allowAllGpts,
  confirmationHeader: 'x-confirmed',
  gptHeader: 'x-gpt-id',
  confirmationTokenPrefix,
  confirmationChallengeTtlMs: getChallengeTtlMs(),
  automationBypassEnabled,
  automationBypassHeader,
});

/**
 * Helper function to determine if an endpoint should be protected by confirmGate
 * based on OpenAI ToS compliance requirements.
 */
export function requiresConfirmation(method: string, path: string): boolean {
  // Safe diagnostic and health check endpoints that should NOT be protected
  const safeEndpoints = [
    'GET /health',
    'GET /',
    'GET /memory/health',
    'GET /memory/load',
    'GET /memory/list',
    'GET /memory/view',
    'GET /workers/status',
    'GET /status',
    'GET /orchestration/status',
    'GET /sdk/diagnostics',
    'GET /sdk/workers/status',
    'GET /backstage',
    'GET /backstage/'
  ];
  
  const requestSignature = `${method} ${path}`;
  
  // Check if this is a safe endpoint
  if (safeEndpoints.some(safe => requestSignature === safe || requestSignature.startsWith(safe))) {
    return false;
  }
  
  // All other endpoints, especially POST/PUT/DELETE operations, require confirmation
  return ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase());
}