/**
 * Environment Validation and Configuration
 * Provides comprehensive environment validation with helpful error messages
 */

import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import { logger } from "@platform/logging/structuredLogging.js";
import type { EnvironmentSecuritySummary } from "@platform/runtime/environmentSecurity.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { getEnv } from "@platform/runtime/env.js";

export interface EnvironmentCheck {
  name: string;
  required: boolean;
  description: string;
  defaultValue?: string;
  validator?: (value: string) => boolean;
  suggestions?: string[];
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

type ValidationLogContext = Record<string, unknown> & {
  state: 'set';
  sensitivity: 'public' | 'sensitive';
  length: number;
  valuePreview?: string;
};

// Environment variable definitions
const environmentChecks: EnvironmentCheck[] = [
  {
    name: 'NODE_ENV',
    required: false,
    description: 'Application environment (development, production, test)',
    defaultValue: 'development',
    validator: (value) => ['development', 'production', 'test'].includes(value)
  },
  {
    name: 'PORT',
    required: false,
    description: 'Server port number',
    // For Railway compatibility and test environments, default to 8080 when not provided
    defaultValue: '8080',
    validator: (value) => {
      const port = parseInt(value, 10);
      return !isNaN(port) && port > 0 && port < 65536;
    }
  },
  {
    name: 'OPENAI_API_KEY',
    required: false, // Optional for mock mode
    description: 'OpenAI API key for AI functionality',
    validator: (value) => {
      // Allow non-production test keys in CI to keep pipelines green without a real secret
      const ciEnv = getEnv('CI');
      const allowMockEnv = getEnv('ALLOW_MOCK_OPENAI');
      const allowMockKey = ciEnv === 'true' || allowMockEnv === 'true';
      if (allowMockKey && value.length > 0) {
        return true;
      }

      return value.startsWith('sk-') && value.length > 20;
    },
    suggestions: [
      'Get your API key from https://platform.openai.com/api-keys',
      'Set OPENAI_API_KEY=your-key-here in your environment',
      'Without this key, AI endpoints will return mock responses'
    ]
  },
  {
    name: 'AI_MODEL',
    required: false,
    description: 'Default AI model to use',
    defaultValue: 'gpt-4o',
    validator: (value) => value.includes('gpt') || value.includes('ft:')
  },
  {
    name: 'FINETUNED_MODEL_ID',
    required: false,
    description: 'Alias for AI_MODEL - OpenAI fine-tuned model identifier for Railway compatibility',
    suggestions: [
      'This is an alias for AI_MODEL for Railway deployment compatibility',
      'Use your fine-tuned model ID or a standard model like gpt-4o or gpt-4o-mini',
      'If both AI_MODEL and FINETUNED_MODEL_ID are set, FINETUNED_MODEL_ID takes precedence'
    ]
  },
  {
    name: 'RAILWAY_ENVIRONMENT',
    required: false,
    description: 'Railway deployment environment identifier',
    defaultValue: 'production',
    validator: (value) => {
      const lower = value.toLowerCase();
      return (
        ['development', 'staging', 'production', 'preview'].includes(lower) ||
        lower.includes('pr-')
      );
    }
  },
  {
    name: 'RAILWAY_API_TOKEN',
    required: false,
    description: 'Railway management API token for GraphQL access',
    validator: (value) => value.length >= 32,
    suggestions: [
      'Generate a Railway API token from https://railway.app/account/tokens',
      'Store the token as RAILWAY_API_TOKEN to enable deployment automation',
      'Keep this token secret – it grants management access to your Railway project'
    ]
  },
  {
    name: 'DATABASE_URL',
    required: false, // Optional for in-memory fallback
    description: 'PostgreSQL connection string',
    validator: (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    suggestions: [
      'Format: postgresql://user:password@host:port/database',
      'For Railway: Use the provided DATABASE_URL from your PostgreSQL service',
      'Without this, the app will use in-memory fallback storage'
    ]
  },
  {
    name: 'RUN_WORKERS',
    required: false,
    description: 'Enable background worker processes',
    defaultValue: 'true',
    validator: (value) => ['true', 'false', '1', '0'].includes(value.toLowerCase())
  },
  {
    name: 'ARC_LOG_PATH',
    required: false,
    description: 'Custom log file directory path',
    defaultValue: '/tmp/arc/log'
  },
  {
    name: 'WORKER_API_TIMEOUT_MS',
    required: false,
    description: 'API timeout for worker operations in milliseconds',
    defaultValue: '60000',
    validator: (value) => {
      const timeout = parseInt(value, 10);
      return !isNaN(timeout) && timeout >= 5000 && timeout <= 300000;
    }
  }
];

function isSensitiveEnvironmentVariable(name: string): boolean {
  return /(key|token|secret|password|credential|database_url|connection|dsn)/i.test(name);
}

function buildValidationLogContext(checkName: string, value: string): ValidationLogContext {
  const isSensitive = isSensitiveEnvironmentVariable(checkName);

  //audit Assumption: validation logs should prove configuration presence without revealing credential material; failure risk: secret prefixes leak into centralized logs and remain queryable after rotation; expected invariant: sensitive environment variables never emit any portion of their raw value; handling strategy: log only set-state/length metadata for sensitive checks and a bounded preview for public values.
  if (isSensitive) {
    return {
      state: 'set',
      sensitivity: 'sensitive',
      length: value.length
    };
  }

  return {
    state: 'set',
    sensitivity: 'public',
    length: value.length,
    valuePreview: `${value.substring(0, 20)}...`
  };
}

/**
 * Validates all environment variables and provides helpful feedback
 */
export function validateEnvironment(): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
    suggestions: []
  };

  logger.info('🔍 Starting environment validation');

  for (const check of environmentChecks) {
    // Use config layer for env access (adapter boundary pattern)
    const value = getEnv(check.name);
    
    if (!value || value.trim() === '') {
      if (check.required) {
        result.errors.push(`❌ Required environment variable ${check.name} is not set`);
        result.isValid = false;
        
        if (check.suggestions) {
          result.suggestions.push(...check.suggestions.map(s => `  💡 ${check.name}: ${s}`));
        }
      } else {
        if (check.defaultValue) {
          result.warnings.push(`⚠️  ${check.name} not set, using default: ${check.defaultValue}`);
          // Set the default value
          process.env[check.name] = check.defaultValue;
        } else {
          result.warnings.push(`⚠️  Optional ${check.name} not set - ${check.description}`);
          
          if (check.suggestions) {
            result.suggestions.push(...check.suggestions.map(s => `  💡 ${check.name}: ${s}`));
          }
        }
      }
      continue;
    }

    // Validate the value if validator is provided
    if (check.validator && !check.validator(value)) {
      result.errors.push(`❌ Invalid value for ${check.name}: "${value}"`);
      result.isValid = false;
      
      if (check.suggestions) {
        result.suggestions.push(...check.suggestions.map(s => `  💡 ${check.name}: ${s}`));
      }
    } else {
      logger.debug(`✅ ${check.name} validation passed`, buildValidationLogContext(check.name, value));
    }
  }

  return result;
}

/**
 * Prints environment validation results with colored output
 */
export function printValidationResults(result: ValidationResult): void {
  console.log('\n🔧 Environment Validation Results');
  console.log('================================');

  if (result.errors.length > 0) {
    console.log('\n❌ ERRORS (must be fixed):');
    result.errors.forEach(error => console.log(`  ${error}`));
  }

  if (result.warnings.length > 0) {
    console.log('\n⚠️  WARNINGS:');
    result.warnings.forEach(warning => console.log(`  ${warning}`));
  }

  if (result.suggestions.length > 0) {
    console.log('\n💡 SUGGESTIONS:');
    result.suggestions.forEach(suggestion => console.log(`${suggestion}`));
  }

  if (result.isValid) {
    console.log('\n✅ Environment validation passed!');
    if (result.warnings.length === 0) {
      console.log('   All required variables are properly configured.');
    }
  } else {
    console.log('\n💥 Environment validation failed!');
    console.log('   Please fix the errors above before starting the application.');
  }

  console.log('================================\n');
}

/**
 * Gets environment information for health checks
 */
export function getEnvironmentInfo() {
  const config = getConfig();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    environment: config.nodeEnv,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    versions: process.versions,
    configuredVariables: environmentChecks
      .filter(check => getEnv(check.name))
      .map(check => ({
        name: check.name,
        hasValue: !!getEnv(check.name),
        isDefault: getEnv(check.name) === check.defaultValue
      }))
  };
}

/**
 * Railway-specific environment validation
 */
export function validateRailwayEnvironment(): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
    suggestions: []
  };

  const config = getConfig();
  const isRailway = config.isRailway;
  
  if (!isRailway) {
    result.warnings.push('⚠️  Not running on Railway platform');
    return result;
  }

  logger.info('🚄 Validating Railway environment');

  // Railway-specific checks
  const railwayChecks = [
    'RAILWAY_PROJECT_ID',
    'RAILWAY_ENVIRONMENT',
    'RAILWAY_SERVICE_ID'
  ];
  
  for (const check of railwayChecks) {
    const value = getEnv(check);
    if (!value) {
      result.warnings.push(`⚠️  Railway variable ${check} not found`);
    }
  }

  const railwayApiToken = getEnv('RAILWAY_API_TOKEN');
  if (!railwayApiToken) {
    result.warnings.push('⚠️  Railway API token (RAILWAY_API_TOKEN) not set - management API features disabled');
  } else {
    logger.info('✅ Railway management API token detected');
  }

  // Check for Railway PostgreSQL
  if (config.databaseUrl && config.databaseUrl.includes('railway.app')) {
    logger.info('✅ Railway PostgreSQL detected');
  }

  // Check port configuration
  if (config.port && config.port !== APPLICATION_CONSTANTS.DEFAULT_PORT) {
    logger.info(`🚄 Railway port override detected: ${config.port}`);
  }

  return result;
}

/**
 * Creates a startup report with all environment information
 */
export function createStartupReport(securitySummary?: EnvironmentSecuritySummary | null): string {
  const envResult = validateEnvironment();
  const _railwayResult = validateRailwayEnvironment();
  const envInfo = getEnvironmentInfo();
  const config = getConfig();

  const securityLines = securitySummary
    ? [
        '🛡️ Environment Security:',
        `├─ Trusted: ${securitySummary.trusted ? '✅' : '❌'}`,
        `├─ Safe Mode: ${securitySummary.safeMode ? 'ENABLED' : 'DISABLED'}`,
        `├─ Fingerprint: ${securitySummary.fingerprint}`,
        securitySummary.matchedFingerprint
          ? `└─ Matched: ${securitySummary.matchedFingerprint}`
          : securitySummary.issues.length > 0
            ? `└─ Issues: ${securitySummary.issues.join('; ')}`
            : '└─ Issues: none'
      ]
    : [
        '🛡️ Environment Security:',
        '└─ Probe pending'
      ];

  const report = [
    '🚀 ARCANOS Startup Report',
    '========================',
    '',
    `Node.js: ${envInfo.nodeVersion}`,
    `Platform: ${envInfo.platform} ${envInfo.arch}`,
    `Environment: ${envInfo.environment}`,
    `Uptime: ${Math.floor(envInfo.uptime)}s`,
    `Memory: ${Math.round(envInfo.memoryUsage.rss / 1024 / 1024)}MB RSS`,
    '',
    '🔧 Configuration Status:',
    `├─ Valid: ${envResult.isValid ? '✅' : '❌'}`,
    `├─ Errors: ${envResult.errors.length}`,
    `├─ Warnings: ${envResult.warnings.length}`,
    `└─ Configured Variables: ${envInfo.configuredVariables.length}`,
    '',
    '🚄 Railway Status:',
    config.isRailway ?
      `├─ Project: ${config.railwayProjectId || 'unknown'}` :
      '├─ Platform: Local/Other',
    `├─ Management API: ${getEnv('RAILWAY_API_TOKEN') ? 'configured' : 'disabled'}`,
    config.databaseUrl?.includes('railway.app') ?
      '└─ Database: Railway PostgreSQL ✅' :
      '└─ Database: External/Local',
    '',
    ...securityLines,
    '',
    '========================'
  ].join('\n');

  return report;
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
  
  const config = getConfig();
  const logPath = config.logPath;
  const memoryPath = config.memoryPath;
  
  //audit Assumption: persistent filesystem paths are risky on Railway; risk: data loss; invariant: logPath should prefer /tmp; handling: warn when persistent prefixes detected.
  if (logPath && isPersistentPath(logPath)) {
    console.warn(`⚠️  LOG PATH WARNING: ${logPath} may not persist on Railway ephemeral FS. Consider using /tmp/`);
  }
  
  //audit Assumption: memory path persistence matters for cache durability; risk: data loss after deploy; invariant: memoryPath should prefer /tmp on Railway; handling: warn on persistent prefixes.
  if (memoryPath && isPersistentPath(memoryPath)) {
    console.warn(`⚠️  MEMORY PATH WARNING: ${memoryPath} may not persist on Railway ephemeral FS. Consider using /tmp/`);
  }
  
  // Check if running on Railway
  //audit Assumption: Railway runtime implies ephemeral FS; risk: misleading logs off-platform; invariant: log Railway info only when detected; handling: guard with config.isRailway.
  if (config.isRailway) {
    logger.info('Running on Railway - using ephemeral filesystem', {
      module: 'environment',
      note: 'Files in /tmp/ and database are suitable for persistence'
    });
  }
}

export default {
  validateEnvironment,
  printValidationResults,
  validateRailwayEnvironment,
  getEnvironmentInfo,
  createStartupReport,
  checkEphemeralFS
};
