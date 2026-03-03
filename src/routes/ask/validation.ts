import type { Request, Response } from 'express';
import { validateInput } from "@platform/runtime/security.js";
import { buildValidationErrorResponse } from "@core/lib/errors/index.js";

const ASK_TEXT_FIELDS = ['prompt', 'message', 'userInput', 'content', 'text', 'query'] as const;
const SYSTEM_MODES = ['system_review', 'system_state'] as const;
type SystemMode = (typeof SYSTEM_MODES)[number];

// Enhanced validation schema for ask requests that accepts multiple text field aliases
const askValidationSchema = {
  mode: { type: 'string' as const, maxLength: 64, sanitize: true },
  async: { type: 'boolean' as const },
  prompt: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  message: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  userInput: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  content: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  text: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  query: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  subject: { type: 'string' as const, minLength: 1, maxLength: 200, sanitize: true },
  expectedVersion: { type: 'number' as const },
  patch: { type: 'object' as const },
  model: { type: 'string' as const, maxLength: 100, sanitize: true },
  temperature: { type: 'number' as const },
  max_tokens: { type: 'number' as const },
  clientContext: { type: 'object' as const },
  sessionId: { type: 'string' as const, maxLength: 100, sanitize: true },
  overrideAuditSafe: { type: 'string' as const, maxLength: 50, sanitize: true },
  metadata: { type: 'object' as const }
};

/**
 * Validate and sanitize ask request payloads.
 *
 * @param req - Express request.
 * @param res - Express response used for validation errors.
 * @param next - Express next handler.
 * @edgeCases Rejects requests missing any supported text field aliases.
 */
export const askValidationMiddleware = (req: Request, res: Response, next: () => void) => {
  const rawSource = req.method === 'GET' ? req.query : req.body;
  const source =
    req.method === 'GET'
      ? Object.fromEntries(
          Object.entries(rawSource).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
        )
      : rawSource;

  const validation = validateInput(source, askValidationSchema);

  if (!validation.isValid) {
    //audit Assumption: validation errors are safe to expose; risk: leaking schema expectations; invariant: only validation errors returned; handling: standardized payload.
    return res.status(400).json(buildValidationErrorResponse(validation.errors));
  }

  const modeValue = validation.sanitized.mode;
  const normalizedMode = typeof modeValue === 'string' && modeValue.trim().length > 0 ? modeValue.trim() : 'chat';

  //audit Assumption: system mode names are fixed and explicit; risk: accidental fallback to chat; invariant: unknown system mode rejected; handling: strict mode allowlist.
  if (normalizedMode.startsWith('system_') && !SYSTEM_MODES.includes(normalizedMode as SystemMode)) {
    return res.status(400).json(
      buildValidationErrorResponse([`Unsupported mode '${normalizedMode}'. Allowed modes: ${SYSTEM_MODES.join(', ')}`])
    );
  }

  if (normalizedMode === 'system_state') {
    const expectedVersion = validation.sanitized.expectedVersion;
    const patch = validation.sanitized.patch;

    //audit Assumption: optimistic-lock writes require both expectedVersion and patch; risk: partial state mutation contract; invariant: both fields present together; handling: reject partial update payloads.
    if ((expectedVersion === undefined) !== (patch === undefined)) {
      return res.status(400).json(
        buildValidationErrorResponse([
          "system_state updates require both 'expectedVersion' and 'patch' fields together"
        ])
      );
    }

    //audit Assumption: expectedVersion must be an integer for deterministic locking; risk: floating-point mismatch; invariant: integer version checks; handling: reject non-integer versions.
    if (typeof expectedVersion === 'number' && !Number.isInteger(expectedVersion)) {
      return res.status(400).json(
        buildValidationErrorResponse(["'expectedVersion' must be an integer when provided"])
      );
    }

    req.body = validation.sanitized;
    next();
    return;
  }

  const hasTextField = ASK_TEXT_FIELDS.some(field => {
    const value = validation.sanitized[field];
    return typeof value === 'string' && value.trim().length > 0;
  });

  if (!hasTextField) {
    //audit Assumption: a text payload is required; risk: rejecting valid requests; invariant: at least one text field must be present; handling: return accepted fields.
    return res
      .status(400)
      .json(
        buildValidationErrorResponse([`Request must include one of ${ASK_TEXT_FIELDS.join(', ')} fields`], {
          acceptedFields: ASK_TEXT_FIELDS,
          maxLength: 10000
        })
      );
  }

  req.body = validation.sanitized;
  next();
};

