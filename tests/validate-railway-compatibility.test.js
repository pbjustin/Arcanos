import { describe, expect, it } from '@jest/globals';
import {
  extractEnvTemplateKeys,
  validateConfig,
  validateEnvTemplate,
} from '../scripts/validate-railway-compatibility.js';

function buildMinimalRailwayConfig(overrides = {}) {
  return {
    build: {
      builder: 'RAILPACK',
      buildCommand: 'npm run build',
    },
    deploy: {
      startCommand: 'node scripts/start-railway-service.mjs',
      healthcheckPath: '/healthz',
      restartPolicyType: 'ON_FAILURE',
      env: {
        RUN_WORKERS: 'true',
      },
    },
    environments: {
      production: {
        variables: {
          NODE_ENV: 'production',
          PORT: '$PORT',
          DATABASE_URL: '$DATABASE_URL',
          OPENAI_API_KEY: '$OPENAI_API_KEY',
          RAILWAY_ENVIRONMENT: 'production',
          RUN_WORKERS: 'true',
        },
      },
    },
    ...overrides,
  };
}

describe('validate-railway-compatibility', () => {
  it('accepts the minimal runtime contract without optional default-backed variables', () => {
    const validationErrors = validateConfig(buildMinimalRailwayConfig());

    expect(validationErrors).toEqual([]);
  });

  it('rejects malformed RUN_WORKERS values in deploy and production env settings', () => {
    const validationErrors = validateConfig(
      buildMinimalRailwayConfig({
        deploy: {
          startCommand: 'node scripts/start-railway-service.mjs',
          healthcheckPath: '/healthz',
          restartPolicyType: 'ON_FAILURE',
          env: {
            RUN_WORKERS: 'sometimes',
          },
        },
        environments: {
          production: {
            variables: {
              NODE_ENV: 'production',
              PORT: '$PORT',
              DATABASE_URL: '$DATABASE_URL',
              OPENAI_API_KEY: '$OPENAI_API_KEY',
              RAILWAY_ENVIRONMENT: 'production',
              RUN_WORKERS: 'sometimes',
            },
          },
        },
      }),
    );

    expect(validationErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('deploy.env.RUN_WORKERS'),
        expect.stringContaining('environments.production.variables.RUN_WORKERS'),
      ]),
    );
  });

  it('still requires documentation coverage for optional production settings', () => {
    const documentedKeys = extractEnvTemplateKeys(`
# NODE_ENV=production
# PORT=$PORT
# DATABASE_URL=$DATABASE_URL
# OPENAI_API_KEY=$OPENAI_API_KEY
# RAILWAY_ENVIRONMENT=production
# RUN_WORKERS=false
`);

    const validationErrors = validateEnvTemplate(documentedKeys);

    expect(validationErrors).toEqual([
      expect.stringContaining('OPENAI_BASE_URL'),
    ]);
    expect(validationErrors[0]).toContain('GPT5_MODEL');
    expect(validationErrors[0]).toContain('ENABLE_CLEAR_2');
  });
});
