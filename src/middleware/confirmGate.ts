import { Request, Response, NextFunction } from 'express';
import {
  createConfirmationChallenge,
  getChallengeTtlMs,
  verifyConfirmationChallenge,
} from './confirmationChallengeStore.js';
import { consumeOneTimeToken } from '../lib/tokenStore.js';
import { getDefaultModel } from '../services/openai/credentialProvider.js';
import { getConfig } from '../config/unifiedConfig.js';
import { getAutomationAuth, getEnv } from '../config/env.js';
import { resolveHeader } from '../utils/requestHeaders.js';

export interface ConfirmationContext {
  confirmationStatus: string;
  gptId?: string;
  manualConfirmation: boolean;
  usedChallengeToken: boolean;
  isTrustedGpt: boolean;
  automationSecretApproved: boolean;
  allowAllOverride: boolean;
  usedOneTimeToken: boolean;
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
  const config = getConfig();
  const candidates = [
    getEnv('FINE_TUNED_AUTOMATION_GPT_ID'),
    getEnv('FINETUNED_AUTOMATION_GPT_ID'),
    config.defaultModel, // From config (handles FINETUNED_MODEL_ID, etc.)
    getEnv('OPENAI_MODEL'),
    getEnv('RAILWAY_OPENAI_MODEL'),
    getEnv('AI_MODEL'),
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
  (getEnv('TRUSTED_GPT_IDS') || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

const implicitlyTrustedFineTunedIds = collectFineTunedAutomationIds();
implicitlyTrustedFineTunedIds.forEach((id) => trustedGptIds.add(id));

const wildcardTrusted = trustedGptIds.has('*');
const allowAllGptsEnv = getEnv('ALLOW_ALL_GPTS');
const allowAllGpts = wildcardTrusted || allowAllGptsEnv === 'true';

const confirmationTokenPrefix = 'token:';
const { headerName: automationBypassHeader, secret: automationBypassSecret } = getAutomationAuth();
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

function maskConfirmationHeader(value: string | undefined): string {
  if (!value) {
    return 'none';
  }

  return value.toLowerCase().startsWith(confirmationTokenPrefix) ? `${confirmationTokenPrefix}***` : value;
}

export function confirmGate(req: Request, res: Response, next: NextFunction): void {
  const confirmationHeader = resolveHeader(req.headers, 'x-confirmed');
  const oneTimeTokenHeader = resolveHeader(req.headers, 'x-arcanos-confirm-token');
  const gptIdHeader = resolveHeader(req.headers, 'x-gpt-id');
  const gptIdFromBody = typeof req.body?.gptId === 'string' ? req.body.gptId : undefined;
  const gptId = gptIdHeader || gptIdFromBody;
  const isTrustedGpt = gptId ? trustedGptIds.has(gptId) : false;
  const automationHeaderValue = automationBypassEnabled
    ? resolveHeader(req.headers, automationBypassHeader)
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
  const oneTimeTokenValue = oneTimeTokenHeader?.toString().trim();

  let hasValidToken = false;
  if (!allowAllGpts && providedToken) {
    try {
      hasValidToken = verifyConfirmationChallenge(providedToken, req.method, req.path);
    } catch (error: unknown) {
      console.error('[🛡️ CONFIRM-GATE] Confirmation challenge verification failed.', error);
      res.status(500).json({
        error: 'Confirmation check failed',
        message: 'Unable to verify confirmation token. Please retry.'
      });
      return;
    }
  }

  let oneTimeTokenApproved = false;
  if (!allowAllGpts && oneTimeTokenValue && !manualConfirmation && !hasValidToken && !isTrustedGpt && !automationBypassApproved) {
    // //audit Assumption: one-time token grants single-use approval; risk: token replay if not consumed; invariant: consume on success; handling: consume + set approval when valid.
    try {
      const tokenResult = consumeOneTimeToken(oneTimeTokenValue);
      oneTimeTokenApproved = tokenResult.ok;
    } catch (error: unknown) {
      console.error('[🛡️ CONFIRM-GATE] One-time token consumption failed.', error);
      res.status(500).json({
        error: 'Confirmation check failed',
        message: 'Unable to verify one-time token. Please retry.'
      });
      return;
    }
  }

  // Log the request for audit purposes
  console.log(
    `[🛡️ CONFIRM-GATE] ${req.method} ${req.path} - Confirmation: ${maskConfirmationHeader(confirmationHeader)} - GPTID: ${
      gptId || 'none'
    } - Mode: ${confirmationMode} - Automation: ${automationBypassApproved ? 'trusted' : 'none'} - OneTimeToken: ${
      oneTimeTokenApproved ? 'approved' : oneTimeTokenValue ? 'provided' : 'none'
    }`,
  );

  // Check if user has explicitly confirmed the action
  if (!manualConfirmation && !hasValidToken && !oneTimeTokenApproved && !isTrustedGpt && !automationBypassApproved && !allowAllGpts) {
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
      'Alternatively, request a one-time token and resend with header: x-arcanos-confirm-token: <token>.',
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
    : oneTimeTokenApproved
    ? 'one-time-token'
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
    usedOneTimeToken: oneTimeTokenApproved,
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
  oneTimeTokenHeader: 'x-arcanos-confirm-token',
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