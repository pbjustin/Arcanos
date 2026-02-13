export type UploadDescriptor =
  | { type: "local"; path: string }
  | { type: "s3"; bucket: string; key: string }
  | { type: "url"; url: string };

export interface UploadResult {
  uploadId: string;
  extractedFiles: string[];
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = "UploadError";
  }
}
