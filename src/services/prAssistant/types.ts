import type { VALIDATION_CONSTANTS } from './constants.js';

export interface CheckResult {
  status: '✅' | '❌' | '⚠️';
  message: string;
  details: string[];
}

export interface PRAnalysisResult {
  status: '✅' | '❌' | '⚠️';
  summary: string;
  checks: {
    deadCodeRemoval: CheckResult;
    simplification: CheckResult;
    openaiCompatibility: CheckResult;
    railwayReadiness: CheckResult;
    automatedValidation: CheckResult;
    finalDoubleCheck: CheckResult;
  };
  reasoning: string;
  recommendations: string[];
}
export type ValidationConfig = typeof VALIDATION_CONSTANTS;

export interface CheckContext {
  workingDir: string;
  validationConstants: ValidationConfig;
}
