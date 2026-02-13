import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";
import { UploadError } from "../types/upload.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) {
  logger.error(err);

  if (err instanceof UploadError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: "Internal server error" });
}
