import { pipeline } from "stream/promises";

/**
 * Purpose: Provide a promise-based stream pipeline helper.
 * Inputs/Outputs: Accepts readable/writable streams and resolves on successful completion.
 * Edge cases: Any stream error rejects to enforce fail-fast flow control.
 */
export const streamPipeline = pipeline;
