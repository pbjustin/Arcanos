export interface UploadDescriptor {
  type: "local" | "s3" | "url";
  path?: string;
  bucket?: string;
  key?: string;
}

export interface UploadResult {
  uploadId: string;
  extractedFiles: string[];
}
