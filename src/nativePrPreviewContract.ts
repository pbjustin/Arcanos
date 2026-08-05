import {
  NATIVE_PR_PREVIEW_E2E_CONTRACT,
} from '../scripts/native-pr-preview-contract.mjs';

export const NATIVE_PR_PREVIEW_MODE =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.mode;

export const NATIVE_PR_PREVIEW_FIXTURE_IDS =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.fixtures;

export const NATIVE_PR_PREVIEW_TRUST_SCOPE =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.trustScope;

export const NATIVE_PR_PREVIEW_RESEARCH_CONTRACT =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.research;

export interface NativePrPreviewIdentity {
  prNumber: number;
  sourceCommit: string;
}
