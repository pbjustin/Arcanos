import { describe, expect, it } from '@jest/globals';
import {
  extractEnvTemplateKeys,
  validateConfig,
  validateDockerfile,
  validateEnvTemplate,
  validateRailwayIgnore,
} from '../scripts/validate-railway-compatibility.js';

function buildMinimalRailwayConfig(overrides = {}) {
  return {
    build: {
      builder: 'RAILPACK',
      buildCommand: 'npm run build',
    },
    deploy: {
      startCommand: 'node scripts/start-railway-service.mjs',
      healthcheckPath: '/readyz',
      healthcheckTimeout: 300,
      drainingSeconds: 60,
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
          ARCANOS_GPT_ACCESS_BASE_URL: '$ARCANOS_GPT_ACCESS_BASE_URL',
          ARCANOS_GPT_ACCESS_SCOPES: '$ARCANOS_GPT_ACCESS_SCOPES',
          RAILWAY_ENVIRONMENT: 'production',
          ARCANOS_PROCESS_KIND: '$ARCANOS_PROCESS_KIND',
        },
      },
      pr: {
        deploy: {
          startCommand: 'node scripts/start-railway-service.mjs --pr-preview-app-safe-v1',
          preDeployCommand: null,
          healthcheckPath: '/readyz',
          healthcheckTimeout: 300,
          cronSchedule: null,
          restartPolicyType: 'NEVER',
          restartPolicyMaxRetries: null,
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
          healthcheckPath: '/readyz',
          healthcheckTimeout: 300,
          drainingSeconds: 60,
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
              ARCANOS_GPT_ACCESS_BASE_URL: '$ARCANOS_GPT_ACCESS_BASE_URL',
              ARCANOS_GPT_ACCESS_SCOPES: '$ARCANOS_GPT_ACCESS_SCOPES',
              RAILWAY_ENVIRONMENT: 'production',
              ARCANOS_PROCESS_KIND: 'sometimes',
            },
          },
          pr: {
            deploy: {
              startCommand: 'node scripts/start-railway-service.mjs --pr-preview-app-safe-v1',
              preDeployCommand: null,
              healthcheckPath: '/readyz',
              healthcheckTimeout: 300,
              cronSchedule: null,
              restartPolicyType: 'NEVER',
              restartPolicyMaxRetries: null,
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

  it('requires role-aware activation and an exact numeric 60-second drain budget', () => {
    const livenessProbeErrors = validateConfig(buildMinimalRailwayConfig({
      deploy: {
        ...buildMinimalRailwayConfig().deploy,
        healthcheckPath: '/health',
      },
    }));
    expect(livenessProbeErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('deploy.healthcheckPath'),
    ]));

    for (const drainingSeconds of [undefined, null, 0, 59, 61, '60', -1]) {
      const config = buildMinimalRailwayConfig();
      if (drainingSeconds === undefined) {
        delete config.deploy.drainingSeconds;
      } else {
        config.deploy.drainingSeconds = drainingSeconds;
      }

      expect(validateConfig(config)).toEqual(expect.arrayContaining([
        expect.stringContaining('deploy.drainingSeconds'),
      ]));
    }

    const prLivenessProbeErrors = validateConfig(buildMinimalRailwayConfig({
      environments: {
        production: buildMinimalRailwayConfig().environments.production,
        pr: {
          deploy: {
            ...buildMinimalRailwayConfig().environments.pr.deploy,
            healthcheckPath: '/health',
          },
        },
      },
    }));
    expect(prLivenessProbeErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('environments.pr.deploy.healthcheckPath'),
    ]));

    for (const healthcheckTimeout of [undefined, null, 299, 301, '300']) {
      const config = buildMinimalRailwayConfig();
      if (healthcheckTimeout === undefined) {
        delete config.deploy.healthcheckTimeout;
      } else {
        config.deploy.healthcheckTimeout = healthcheckTimeout;
      }

      expect(validateConfig(config)).toEqual(expect.arrayContaining([
        expect.stringContaining('deploy.healthcheckTimeout'),
      ]));
    }
  });

  it('requires production and PR deploy overrides to inherit the root readiness and drain contract', () => {
    for (const [field, values] of [
      ['healthcheckPath', ['/readyz', '/health']],
      ['healthcheckTimeout', [300, 1]],
      ['drainingSeconds', [60, 0]],
    ]) {
      for (const value of values) {
        const config = buildMinimalRailwayConfig();
        config.environments.production.deploy = { [field]: value };

        expect(validateConfig(config)).toEqual(expect.arrayContaining([
          expect.stringContaining(`environments.production.deploy.${field} must be omitted`),
        ]));
      }
    }

    for (const drainingSeconds of [60, 0, '60', null]) {
      const config = buildMinimalRailwayConfig();
      config.environments.pr.deploy.drainingSeconds = drainingSeconds;

      expect(validateConfig(config)).toEqual(expect.arrayContaining([
        expect.stringContaining('environments.pr.deploy.drainingSeconds must be omitted'),
      ]));
    }
  });

  it('rejects provider-native drain variables that can override the canonical deploy field', () => {
    const deployEnvConfig = buildMinimalRailwayConfig();
    deployEnvConfig.deploy.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS = '60';
    expect(validateConfig(deployEnvConfig)).toEqual(expect.arrayContaining([
      expect.stringContaining('deploy.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS'),
    ]));

    const environmentVariableConfig = buildMinimalRailwayConfig();
    environmentVariableConfig.environments.staging = {
      variables: {
        RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '0',
      },
    };
    expect(validateConfig(environmentVariableConfig)).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'environments.staging.variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
      ),
    ]));

    const environmentDeployConfig = buildMinimalRailwayConfig();
    environmentDeployConfig.environments.staging = {
      deploy: {
        healthcheckPath: '/health',
        healthcheckTimeout: 1,
        drainingSeconds: 0,
        env: {
          RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '0',
        },
      },
    };
    expect(validateConfig(environmentDeployConfig)).toEqual(expect.arrayContaining([
      expect.stringContaining('environments.staging.deploy.healthcheckPath'),
      expect.stringContaining('environments.staging.deploy.healthcheckTimeout'),
      expect.stringContaining('environments.staging.deploy.drainingSeconds'),
      expect.stringContaining(
        'environments.staging.deploy.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
      ),
    ]));
  });

  it('requires the exact numeric 300-second timeout in the PR deploy override', () => {
    for (const healthcheckTimeout of [undefined, null, 299, 301, '300']) {
      const config = buildMinimalRailwayConfig();
      if (healthcheckTimeout === undefined) {
        delete config.environments.pr.deploy.healthcheckTimeout;
      } else {
        config.environments.pr.deploy.healthcheckTimeout = healthcheckTimeout;
      }

      expect(validateConfig(config)).toEqual(expect.arrayContaining([
        expect.stringContaining('environments.pr.deploy.healthcheckTimeout'),
      ]));
    }
  });

  it('rejects missing or weakened native PR preview overrides', () => {
    const missingPreviewErrors = validateConfig(buildMinimalRailwayConfig({
      environments: {
        production: buildMinimalRailwayConfig().environments.production,
      },
    }));
    expect(missingPreviewErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('environments.pr.deploy'),
    ]));

    const weakenedPreviewErrors = validateConfig(buildMinimalRailwayConfig({
      environments: {
        production: buildMinimalRailwayConfig().environments.production,
        pr: {
          variables: { FORCE_MOCK: 'true' },
          deploy: {
            startCommand: 'node scripts/start-railway-service.mjs',
            preDeployCommand: 'node scripts/action-plan-execution-migration.mjs --apply',
            healthcheckPath: '/healthz',
            cronSchedule: '*/5 * * * *',
            restartPolicyType: 'ON_FAILURE',
            restartPolicyMaxRetries: 10,
          },
        },
      },
    }));

    expect(weakenedPreviewErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('environments.pr.variables'),
      expect.stringContaining('--pr-preview-app-safe-v1'),
      expect.stringContaining('preDeployCommand'),
      expect.stringContaining('healthcheckPath'),
      expect.stringContaining('cronSchedule'),
      expect.stringContaining('restartPolicyType'),
      expect.stringContaining('restartPolicyMaxRetries'),
    ]));
  });

  it('still requires documentation coverage for optional production settings', () => {
    const documentedKeys = extractEnvTemplateKeys(`
# NODE_ENV=production
# PORT=$PORT
# DATABASE_URL=$DATABASE_URL
# OPENAI_API_KEY=$OPENAI_API_KEY
# ARCANOS_GPT_ACCESS_TOKEN=$ARCANOS_GPT_ACCESS_TOKEN
# ARCANOS_GPT_ACCESS_BASE_URL=$ARCANOS_GPT_ACCESS_BASE_URL
# ARCANOS_GPT_ACCESS_SCOPES=$ARCANOS_GPT_ACCESS_SCOPES
# RAILWAY_ENVIRONMENT=production
# ARCANOS_PROCESS_KIND=web
# RUN_WORKERS=false
`);

    const validationErrors = validateEnvTemplate(documentedKeys);

    expect(validationErrors).toEqual([
      expect.stringContaining('OPENAI_BASE_URL'),
    ]);
    expect(validationErrors[0]).toContain('GPT5_MODEL');
    expect(validationErrors[0]).toContain('JOB_WORKER_HEARTBEAT_MS');
    expect(validationErrors[0]).toContain('JOB_WORKER_STALE_AFTER_MS');
    expect(validationErrors[0]).toContain('JOB_WORKER_WATCHDOG_MS');
    expect(validationErrors[0]).toContain('JOB_WORKER_WATCHDOG_IDLE_MS');
    expect(validationErrors[0]).toContain('ENABLE_CLEAR_2');
  });

  it('requires Dockerfile to boot through the Railway launcher', () => {
    expect(
      validateDockerfile('CMD ["sh", "-c", "NODE_OPTIONS=\'--max-old-space-size=7168\' npm start"]')
    ).toEqual([
      expect.stringContaining('CMD ["node", "scripts/start-railway-service.mjs"]'),
      expect.stringContaining('COPY prisma/ ./prisma/'),
      expect.stringContaining('COPY vendor/ ./vendor/'),
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
        'COPY vendor/ ./vendor/',
        'RUN npm install --include=dev --no-audit --no-fund && \\',
        '    npx --yes prisma@5.22.0 generate --schema ./prisma/schema.prisma && \\',
        '    npm run build',
        'CMD ["node", "scripts/start-railway-service.mjs"]',
      ].join('\n'))
    ).toEqual([]);
  });

  it('rejects Railway build contexts that omit vendored npm file dependencies', () => {
    expect(validateRailwayIgnore('node_modules/\nvendor/\n')).toEqual([
      expect.stringContaining('vendor/')
    ]);

    expect(validateRailwayIgnore('node_modules/\nlogs/\n')).toEqual([]);
  });
});
