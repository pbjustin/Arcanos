import { Request, Response, NextFunction } from 'express';

/**
 * ConfirmGate Middleware - OpenAI Terms of Service Compliance
 * 
 * Ensures all sensitive API endpoints require explicit user confirmation
 * before executing any logic. This prevents automatic GPT actions without
 * user consent, maintaining compliance with OpenAI's Terms of Service.
 * 
 * Requires 'x-confirmed: yes' header for request to proceed.
 */
const trustedGptIds = new Set(
  (process.env.TRUSTED_GPT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function confirmGate(req: Request, res: Response, next: NextFunction): void {
  const confirmationHeader = normalizeHeaderValue(req.headers['x-confirmed']);
  const gptIdHeader = normalizeHeaderValue(req.headers['x-gpt-id'] as string | string[] | undefined);
  const gptIdFromBody = typeof req.body?.gptId === 'string' ? req.body.gptId : undefined;
  const gptId = gptIdHeader || gptIdFromBody;
  const isTrustedGpt = gptId ? trustedGptIds.has(gptId) : false;

  // Log the request for audit purposes
  console.log(
    `[🛡️ CONFIRM-GATE] ${req.method} ${req.path} - Confirmation: ${confirmationHeader || 'none'} - GPTID: ${
      gptId || 'none'
    }`
  );

  // Check if user has explicitly confirmed the action
  if (confirmationHeader !== 'yes' && !isTrustedGpt) {
    res.setHeader('x-confirmation-status', 'required');
    console.log(
      `[❌ CONFIRM-GATE] Request blocked - missing or invalid confirmation header${
        gptId ? ` (GPTID ${gptId} not trusted)` : ''
      }`
    );

    res.status(403).json({
      error: 'Confirmation required',
      message:
        'This endpoint requires explicit user confirmation. Please include the header: x-confirmed: yes or use a trusted GPTID.',
      code: 'CONFIRMATION_REQUIRED',
      endpoint: req.path,
      method: req.method,
      gptId: gptId || null,
      confirmationRequired: true,
      timestamp: new Date().toISOString()
    });
    return;
  }

  res.setHeader('x-confirmation-status', 'confirmed');
  console.log(`[✅ CONFIRM-GATE] Request confirmed - proceeding with execution`);
  next();
}

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