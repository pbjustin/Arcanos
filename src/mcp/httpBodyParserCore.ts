import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

export const MCP_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;

const byteUnitMultipliers: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  tib: 1024 * 1024 * 1024 * 1024,
};
const expressByteUnitMultipliers: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  pb: 1024 * 1024 * 1024 * 1024 * 1024,
};
const expressByteLimitPattern = /^([+-]?\d+(?:\.\d+)?) *(kb|mb|gb|tb|pb)$/i;
const mcpHttpBodyParserApplied = Symbol('mcpHttpBodyParserApplied');

type McpHttpBodyRequest = Request & {
  [mcpHttpBodyParserApplied]?: true;
};

/**
 * Match the bytes@3 parser used by Express without importing an undeclared
 * transitive dependency. This keeps JSON_LIMIT's existing grammar and startup
 * failure behavior while allowing the earlier MCP parser to honor that bound.
 */
function resolveExpressJsonLimitBytes(rawValue: string): number {
  const match = expressByteLimitPattern.exec(rawValue);
  const value = match
    ? Number.parseFloat(match[1])
    : Number.parseInt(rawValue, 10);
  if (Number.isNaN(value)) {
    throw new TypeError(`option limit "${String(rawValue)}" is invalid`);
  }

  const multiplier = match
    ? expressByteUnitMultipliers[match[2].toLowerCase()]
    : expressByteUnitMultipliers.b;
  return Math.floor(value * multiplier);
}

/**
 * Resolve the three reviewed inputs to the effective MCP parser limit.
 * Environment access remains in the configured wrapper, keeping this core
 * deterministic and safe for the credential-empty native preview fixture.
 */
export function resolveConfiguredMcpHttpBodyLimitBytes(
  rawValue: string | undefined,
  globalJsonLimit: string
): number {
  const normalized = rawValue?.trim().toLowerCase();
  let configuredMcpLimit = MCP_HTTP_BODY_LIMIT_BYTES;
  if (!normalized) {
    configuredMcpLimit = MCP_HTTP_BODY_LIMIT_BYTES;
  } else {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/u.exec(normalized);
    if (!match) {
      throw new RangeError(
        'MCP_HTTP_BODY_LIMIT must be a non-negative byte value with an optional binary unit.'
      );
    }

    const value = Number(match[1]);
    const multiplier = byteUnitMultipliers[match[2] ?? 'b'];
    const bytes = Math.floor(value * multiplier);
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('MCP_HTTP_BODY_LIMIT is outside the supported numeric range.');
    }
    configuredMcpLimit = bytes;
  }

  return Math.min(
    configuredMcpLimit,
    resolveExpressJsonLimitBytes(globalJsonLimit),
    MCP_HTTP_BODY_LIMIT_BYTES
  );
}

function isRequestEntityTooLarge(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  return candidate.type === 'entity.too.large'
    || candidate.status === 413
    || candidate.statusCode === 413;
}

function sendMcpRequestTooLarge(req: Request, res: Response): void {
  try {
    req.logger?.warn('mcp_http.request_rejected', {
      errorCode: 'MCP_REQUEST_TOO_LARGE',
      statusCode: 413,
      requestId: req.requestId,
      traceId: req.traceId,
    });
  } catch {
    // Diagnostics must not alter the fixed public parser response.
  }

  res.status(413).json({
    error: 'MCP_REQUEST_TOO_LARGE',
    message: 'MCP request body is too large.',
  });
}

/**
 * Construct the production MCP JSON pre-parser at an already-resolved byte
 * limit. The application creates one configured instance; the sealed preview
 * creates isolated instances against server-owned in-memory request streams.
 */
export function createMcpHttpBodyParser(limitBytes: number): RequestHandler {
  if (
    !Number.isSafeInteger(limitBytes)
    || limitBytes < 0
    || limitBytes > MCP_HTTP_BODY_LIMIT_BYTES
  ) {
    throw new RangeError(
      'MCP HTTP body limit must be between zero and the 1 MiB hard maximum.'
    );
  }
  const jsonBodyParser = express.json({
    limit: limitBytes,
    strict: true,
  });

  return (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    const mcpRequest = req as McpHttpBodyRequest;
    if (mcpRequest[mcpHttpBodyParserApplied]) {
      next();
      return;
    }
    mcpRequest[mcpHttpBodyParserApplied] = true;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    jsonBodyParser(req, res, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      if (isRequestEntityTooLarge(error)) {
        sendMcpRequestTooLarge(req, res);
        return;
      }
      next(error);
    });
  };
}
