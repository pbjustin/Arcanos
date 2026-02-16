export type UploadType = "local" | "s3" | "url";

export type UploadErrorCode =
  | "UPLOAD_VALIDATION_FAILED"
  | "UPLOAD_STREAM_FAILED"
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_ABORTED"
  | "UPLOAD_INVALID_MIME"
  | "UPLOAD_EXTRACTION_FAILED"
  | "UPLOAD_CLEANUP_FAILED"
  | "UPLOAD_MALWARE_DETECTED"
  | "UPLOAD_SCANNER_UNAVAILABLE"
  | "UPLOAD_UNSUPPORTED_DESCRIPTOR";

export interface UploadDescriptor {
  type: UploadType;
  path?: string;
  bucket?: string;
  key?: string;
  url?: string;
}

export interface UploadResult {
  uploadId: string;
  extractedFiles: string[];
}

export interface AnalyzeResult {
  uploadId: string;
  analysis: string;
  filesAnalyzed: number;
  truncated: boolean;
}

export interface UploadErrorContext {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class UploadError extends Error {
  public readonly statusCode: number;

  public readonly code: UploadErrorCode;

  public readonly details: Record<string, unknown> | undefined;

  public readonly cause: unknown;

  constructor(
    message: string,
    statusCode: number = 400,
    code: UploadErrorCode = "UPLOAD_VALIDATION_FAILED",
    context?: UploadErrorContext
  ) {
    super(message);
    this.name = "UploadError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = context?.details;
    this.cause = context?.cause;
  }
}

/**
 * Purpose: Narrow unknown errors to UploadError for response handling.
 * Inputs/Outputs: Accepts `unknown`, returns true only for UploadError instances.
 * Edge cases: Cross-package Error instances are treated as non-upload errors.
 */
export function isUploadError(candidateError: unknown): candidateError is UploadError {
  //audit Assumption: runtime prototype chain is intact for UploadError checks.
  //audit Failure risk: wrapped/serialized errors may fail `instanceof` checks.
  //audit Invariant: only true UploadError instances return true.
  //audit Handling: fallback error mapping occurs in middleware for unknown errors.
  return candidateError instanceof UploadError;
}
