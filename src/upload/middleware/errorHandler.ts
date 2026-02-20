import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";
import { isUploadError } from "../types/upload.js";

/**
 * Purpose: Convert thrown upload pipeline errors into API-safe JSON responses.
 * Inputs/Outputs: Accepts Express error middleware arguments and sends normalized response payload.
 * Edge cases: Unknown errors are mapped to generic 500 responses without leaking internals.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error(
    {
      error: err,
      method: req.method,
      path: req.path,
      requestId: req.headers["x-request-id"],
    },
    "Upload request failed"
  );

  //audit Assumption: UploadError instances contain client-safe status and code metadata.
  //audit Failure risk: treating all errors as internal can hide actionable client feedback.
  //audit Invariant: known upload errors preserve their intended HTTP status codes.
  //audit Handling: serialize UploadError fields and fallback to generic 500 for unknown errors.
  if (isUploadError(err)) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details,
    });
    return;
  }

  res.status(500).json({ error: "Internal server error" });
}
