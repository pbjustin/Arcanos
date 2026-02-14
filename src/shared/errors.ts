/**
 * Shared-layer error types.
 *
 * Purpose: Provide error classes that can be used by shared utilities without
 * depending on higher-level application layers.
 * Inputs/Outputs: Constructors accept a message and optional cause metadata.
 * Edge cases: Preserves Error prototype chain for `instanceof` checks.
 */
export class SharedError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);

    //audit Assumption: attaching cause is useful for diagnostics; risk: cause may be unavailable in older runtimes; invariant: error remains usable; handling: assign only when provided.
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * File storage operation error in shared utilities.
 *
 * Purpose: Signal file read/write failures in the shared layer.
 * Inputs/Outputs: Accepts operation code and message, returns typed Error.
 * Edge cases: Keeps a stable default message when no details are provided.
 */
export class FileStorageError extends SharedError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message || 'File storage error', options);
  }
}

