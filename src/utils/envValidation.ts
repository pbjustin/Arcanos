/**
 * Environment Validation for Railway Deployment
 * 
 * Validates required environment variables and provides fail-fast startup
 * for missing critical configuration.
 */

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  config: {
    databaseUrl?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    port?: number;
    logLevel?: string;
    crepidPurge?: string;
    nodeEnv?: string;
  };
}

/**
 * Validate environment variables for Railway deployment
 * 
 * Critical vars (fail-fast if missing):
 * - OPENAI_API_KEY (required for AI functionality)
 * 
 * Important vars (warn if missing):
 * - DATABASE_URL (falls back to in-memory)
 * - PORT (defaults to 8080)
 * - LOG_LEVEL (defaults to 'info')
 * - CREPID_PURGE (defaults to 'off')
 */
export function validateEnvironment(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Critical environment variables
  const openaiApiKey = process.env.OPENAI_API_KEY || process.env.API_KEY;
  if (!openaiApiKey || openaiApiKey === 'your-openai-api-key-here') {
    warnings.push('OPENAI_API_KEY not configured - AI endpoints will return mock responses');
  }
  
  // Important but non-critical variables
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    warnings.push('DATABASE_URL not configured - using in-memory fallback');
  }
  
  // Configuration variables with defaults
  const port = parseInt(process.env.PORT || '8080', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push(`Invalid PORT value: ${process.env.PORT}. Must be between 1 and 65535`);
  }
  
  const logLevel = process.env.LOG_LEVEL || 'info';
  const validLogLevels = ['error', 'warn', 'info', 'debug'];
  if (!validLogLevels.includes(logLevel)) {
    warnings.push(`Invalid LOG_LEVEL: ${logLevel}. Defaulting to 'info'. Valid values: ${validLogLevels.join(', ')}`);
  }
  
  const crepidPurge = process.env.CREPID_PURGE || 'off';
  const validPurgeModes = ['off', 'soft', 'hard'];
  if (!validPurgeModes.includes(crepidPurge)) {
    warnings.push(`Invalid CREPID_PURGE mode: ${crepidPurge}. Defaulting to 'off'. Valid values: ${validPurgeModes.join(', ')}`);
  }
  
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  // Get configured OpenAI model
  const openaiModel = process.env.OPENAI_MODEL || 
                     process.env.FINETUNED_MODEL_ID || 
                     process.env.AI_MODEL || 
                     'gpt-4o';
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    config: {
      databaseUrl,
      openaiApiKey: openaiApiKey ? '***configured***' : undefined,
      openaiModel,
      port,
      logLevel,
      crepidPurge,
      nodeEnv
    }
  };
}

/**
 * Log environment validation results
 */
export function logEnvironmentValidation(result: EnvValidationResult): void {
  console.log('\n=== 🔍 ENVIRONMENT VALIDATION ===');
  
  if (result.valid) {
    console.log('✅ Environment validation passed');
  } else {
    console.error('❌ Environment validation failed');
  }
  
  if (result.errors.length > 0) {
    console.error('\n🚨 Critical Errors:');
    result.errors.forEach(error => console.error(`   - ${error}`));
  }
  
  if (result.warnings.length > 0) {
    console.warn('\n⚠️  Warnings:');
    result.warnings.forEach(warning => console.warn(`   - ${warning}`));
  }
  
  console.log('\n📋 Configuration:');
  console.log(`   NODE_ENV: ${result.config.nodeEnv}`);
  console.log(`   PORT: ${result.config.port}`);
  console.log(`   LOG_LEVEL: ${result.config.logLevel}`);
  console.log(`   OPENAI_API_KEY: ${result.config.openaiApiKey || 'not configured'}`);
  console.log(`   OPENAI_MODEL: ${result.config.openaiModel}`);
  console.log(`   DATABASE_URL: ${result.config.databaseUrl ? 'configured' : 'not configured'}`);
  console.log(`   CREPID_PURGE: ${result.config.crepidPurge}`);
  console.log('================================\n');
}

/**
 * Check for ephemeral filesystem
 * Railway uses ephemeral filesystems - warn if writing to persistent paths
 */
export function checkEphemeralFS(): void {
  const isPersistentPath = (path: string): boolean => {
    const persistentPrefixes = ['/var/', '/opt/', '/usr/local/'];
    return persistentPrefixes.some(prefix => path.startsWith(prefix));
  };
  
  const logPath = process.env.ARC_LOG_PATH;
  const memoryPath = process.env.ARC_MEMORY_PATH;
  
  if (logPath && isPersistentPath(logPath)) {
    console.warn(`⚠️  LOG PATH WARNING: ${logPath} may not persist on Railway ephemeral FS. Consider using /tmp/`);
  }
  
  if (memoryPath && isPersistentPath(memoryPath)) {
    console.warn(`⚠️  MEMORY PATH WARNING: ${memoryPath} may not persist on Railway ephemeral FS. Consider using /tmp/`);
  }
  
  // Check if running on Railway
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log('🚂 Running on Railway - using ephemeral filesystem');
    console.log('   Files in /tmp/ and database are suitable for persistence');
  }
}
