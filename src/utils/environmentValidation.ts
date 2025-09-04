/**
 * Environment Validation and Configuration
 * Provides comprehensive environment validation with helpful error messages
 */

import { logger } from './structuredLogging.js';

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
    validator: (value) => value.startsWith('sk-') && value.length > 20,
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
    defaultValue: 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote',
    validator: (value) => value.includes('gpt') || value.includes('ft:')
  },
  {
    name: 'FINETUNED_MODEL_ID',
    required: false,
    description: 'Alias for AI_MODEL - OpenAI fine-tuned model identifier for Railway compatibility',
    suggestions: [
      'This is an alias for AI_MODEL for Railway deployment compatibility',
      'Use your fine-tuned model ID: ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote',
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
        lower.startsWith('pr')
      );
    }
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
    const value = process.env[check.name];
    
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
      logger.debug(`✅ ${check.name} validation passed`, { value: value.substring(0, 20) + '...' });
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
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    versions: process.versions,
    configuredVariables: environmentChecks
      .filter(check => process.env[check.name])
      .map(check => ({
        name: check.name,
        hasValue: !!process.env[check.name],
        isDefault: process.env[check.name] === check.defaultValue
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

  const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID;
  
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
    if (!process.env[check]) {
      result.warnings.push(`⚠️  Railway variable ${check} not found`);
    }
  }

  // Check for Railway PostgreSQL
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.app')) {
    logger.info('✅ Railway PostgreSQL detected');
  }

  // Check port configuration
  const port = process.env.PORT;
  if (port && port !== '8080') {
    logger.info(`🚄 Railway port override detected: ${port}`);
  }

  return result;
}

/**
 * Creates a startup report with all environment information
 */
export function createStartupReport(): string {
  const envResult = validateEnvironment();
  const _railwayResult = validateRailwayEnvironment();
  const envInfo = getEnvironmentInfo();

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
    process.env.RAILWAY_ENVIRONMENT ? 
      `├─ Project: ${process.env.RAILWAY_PROJECT_ID}` : 
      '├─ Platform: Local/Other',
    process.env.DATABASE_URL?.includes('railway.app') ? 
      '└─ Database: Railway PostgreSQL ✅' : 
      '└─ Database: External/Local',
    '',
    '========================'
  ].join('\n');

  return report;
}

export default {
  validateEnvironment,
  printValidationResults,
  validateRailwayEnvironment,
  getEnvironmentInfo,
  createStartupReport
};