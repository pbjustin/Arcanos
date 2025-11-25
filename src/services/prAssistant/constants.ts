import type { ValidationConfig } from './types.js';

export const VALIDATION_CONSTANTS: ValidationConfig = {
  LARGE_FILE_THRESHOLD: 500, // Lines threshold for large file detection
  LARGE_STRING_THRESHOLD: 100, // Character threshold for large inline strings
  TEST_TIMEOUT: 120000, // 2 minutes timeout for test execution
  BUILD_TIMEOUT: 120000, // 2 minutes timeout for build execution
  LINT_TIMEOUT: 60000, // 1 minute timeout for linting
  DEFAULT_PORT: 3000 // Fallback default port if config is unavailable
};

export const RAILWAY_VALIDATION_PATTERNS = [
  { pattern: /(?:http:\/\/|https:\/\/)(?!localhost|127\.0\.0\.1|example\.com)/gi, message: 'Hardcoded URLs detected' },
  { pattern: /['"`]\w+\.\w+\.\w+['"`]/gi, message: 'Potential hardcoded domains' },
  { pattern: /:\s*\d{4,5}(?!\s*[,}\]])/gi, message: 'Hardcoded port numbers' },
  { pattern: /password\s*[=:]\s*['"`][^'"`]{3,}['"`]/gi, message: 'Hardcoded password detected' },
  { pattern: /api[_-]?key\s*[=:]\s*['"`][^'"`]{10,}['"`]/gi, message: 'Hardcoded API key detected' }
] as const;
