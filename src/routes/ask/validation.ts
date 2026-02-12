import type { Request, Response } from 'express';
import { validateInput } from "@platform/runtime/security.js";
import { buildValidationErrorResponse } from "@core/lib/errors/index.js";

const ASK_TEXT_FIELDS = ['prompt', 'userInput', 'content', 'text', 'query'] as const;

// Enhanced validation schema for ask requests that accepts multiple text field aliases
const askValidationSchema = {
  prompt: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  userInput: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  content: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  text: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  query: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
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
