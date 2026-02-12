/**
 * Purpose: compatibility shim for the transitional core/lib/errors path.
 * Inputs/Outputs: re-exports the canonical consolidated error library.
 * Edge cases: avoids broken relative imports when only canonical modules exist.
 */
export * from '../../../lib/errors/index.js';
