import { describe, expect, it } from '@jest/globals';
import {
  extractEnvTemplateKeys,
  validateConfig,
  validateDockerfile,
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
      healthcheckPath: '/health',
      restartPolicyType: 'ON_FAILURE',
      env: {
        ARCANOS_PROCESS_KIND: '$ARCANOS_PROCESS_KIND',
      },
    },
    environments: {
      production: {
        variables: {
          NODE_ENV: 'production',
          PORT: '$PORT',
          DATABASE_URL: '$DATABASE_URL',
          OPENAI_API_KEY: '$OPENAI_API_KEY',
          ARCANOS_GPT_ACCESS_TOKEN: '$ARCANOS_GPT_ACCESS_TOKEN',
          RAILWAY_ENVIRONMENT: 'production',
          ARCANOS_PROCESS_KIND: '$ARCANOS_PROCESS_KIND',
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

  it('rejects malformed ARCANOS_PROCESS_KIND values in deploy and production env settings', () => {
    const validationErrors = validateConfig(
      buildMinimalRailwayConfig({
        deploy: {
          startCommand: 'node scripts/start-railway-service.mjs',
          healthcheckPath: '/health',
          restartPolicyType: 'ON_FAILURE',
          env: {
            ARCANOS_PROCESS_KIND: 'sometimes',
          },
        },
        environments: {
          production: {
            variables: {
              NODE_ENV: 'production',
              PORT: '$PORT',
              DATABASE_URL: '$DATABASE_URL',
              OPENAI_API_KEY: '$OPENAI_API_KEY',
              ARCANOS_GPT_ACCESS_TOKEN: '$ARCANOS_GPT_ACCESS_TOKEN',
              RAILWAY_ENVIRONMENT: 'production',
              ARCANOS_PROCESS_KIND: 'sometimes',
            },
          },
        },
      }),
    );

    expect(validationErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('deploy.env.ARCANOS_PROCESS_KIND'),
        expect.stringContaining('environments.production.variables.ARCANOS_PROCESS_KIND'),
      ]),
    );
  });

  it('still requires documentation coverage for optional production settings', () => {
    const documentedKeys = extractEnvTemplateKeys(`
# NODE_ENV=production
# PORT=$PORT
# DATABASE_URL=$DATABASE_URL
# OPENAI_API_KEY=$OPENAI_API_KEY
# ARCANOS_GPT_ACCESS_TOKEN=$ARCANOS_GPT_ACCESS_TOKEN
# RAILWAY_ENVIRONMENT=production
# ARCANOS_PROCESS_KIND=web
# RUN_WORKERS=false
`);

    const validationErrors = validateEnvTemplate(documentedKeys);

    expect(validationErrors).toEqual([
      expect.stringContaining('OPENAI_BASE_URL'),
    ]);
    expect(validationErrors[0]).toContain('GPT5_MODEL');
    expect(validationErrors[0]).toContain('ENABLE_CLEAR_2');
  });

  it('requires Dockerfile to boot through the Railway launcher', () => {
    expect(
      validateDockerfile('CMD ["sh", "-c", "NODE_OPTIONS=\'--max-old-space-size=7168\' npm start"]')
    ).toEqual([
      expect.stringContaining('CMD ["node", "scripts/start-railway-service.mjs"]'),
      expect.stringContaining('COPY prisma/ ./prisma/'),
      expect.stringContaining('npx --yes prisma@5.22.0 generate --schema ./prisma/schema.prisma'),
      expect.stringContaining('ENV RAILWAY_CLI_BIN=/usr/local/bin/railway-native'),
      expect.stringContaining('npm install --global @railway/cli@4.30.2 --no-audit --no-fund'),
      expect.stringContaining('railway-v4.30.2-x86_64-unknown-linux-musl.tar.gz'),
      expect.stringContaining('/usr/local/bin/railway-native --version'),
    ]);

    expect(
      validateDockerfile([
        'ENV RAILWAY_CLI_BIN=/usr/local/bin/railway-native',
        'RUN npm install --global @railway/cli@4.30.2 --no-audit --no-fund',
        'RUN wget -qO /tmp/railway-cli.tar.gz https://github.com/railwayapp/cli/releases/download/v4.30.2/railway-v4.30.2-x86_64-unknown-linux-musl.tar.gz && \\',
        '    /usr/local/bin/railway-native --version',
        'COPY prisma/ ./prisma/',
        'RUN npm install --include=dev --no-audit --no-fund && \\',
        '    npx --yes prisma@5.22.0 generate --schema ./prisma/schema.prisma && \\',
        '    npm run build',
        'CMD ["node", "scripts/start-railway-service.mjs"]',
      ].join('\n'))
    ).toEqual([]);
  });
});
