import { isRecord } from '@shared/typeGuards.js';

export const CORE_GPT_ID = 'arcanos-core';
export const CORE_GPT_JOB_PATH = '/chatgpt/core/mcp';
export const CORE_GPT_JOB_REASON = 'chatgpt_core_query_v1';

/** This provenance is written only by the private Core job producer. */
export function isCoreGptJobInput(value: unknown): boolean {
  return isRecord(value) && value.requestPath === CORE_GPT_JOB_PATH;
}
