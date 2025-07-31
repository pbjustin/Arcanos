/**
 * @deprecated This file is deprecated. Use ai-service-consolidated.ts instead.
 * Legacy code interpreter service - migrated to unified OpenAI service
 */

import { codeInterpreterService } from './ai-service-consolidated';

// Re-export for backward compatibility
export { codeInterpreterService, type CodeInterpreterResult } from './ai-service-consolidated';
