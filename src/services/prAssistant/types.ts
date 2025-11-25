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

export interface ValidationConfig {
  LARGE_FILE_THRESHOLD: number;
  LARGE_STRING_THRESHOLD: number;
  TEST_TIMEOUT: number;
  BUILD_TIMEOUT: number;
  LINT_TIMEOUT: number;
  DEFAULT_PORT: number;
}

export interface CheckContext {
  workingDir: string;
  validationConstants: ValidationConfig;
}
