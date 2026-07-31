import {
  NATIVE_PR_PREVIEW_E2E_CONTRACT,
} from '../scripts/native-pr-preview-contract.mjs';

export const NATIVE_PR_PREVIEW_MODE =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.mode;

export const NATIVE_PR_PREVIEW_FIXTURE_IDS =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.fixtures;

export const NATIVE_PR_PREVIEW_TRUST_SCOPE =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.trustScope;

export interface NativePrPreviewIdentity {
  prNumber: number;
  sourceCommit: string;
}
