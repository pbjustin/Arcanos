#!/usr/bin/env node
/**
 * Railway compatibility validation script.
 *
 * Purpose:
 * - Validate deploy/build contract in railway.json.
 * - Fail fast in CI when Railway runtime invariants drift.
 *
 * Inputs/Outputs:
 * - Input: repository railway.json.
 * - Output: process exit code 0 on success, 1 on validation failure.
 *
 * Edge cases:
 * - Missing or malformed railway.json is treated as a hard failure.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = process.cwd();
const RAILWAY_CONFIG_PATH = path.join(PROJECT_ROOT, 'railway.json');
const ENV_TEMPLATE_PATH = path.join(PROJECT_ROOT, '.env.example');
const DOCKERFILE_PATH = path.join(PROJECT_ROOT, 'Dockerfile');
const RAILWAYIGNORE_PATH = path.join(PROJECT_ROOT, '.railwayignore');
const EXPECTED_START_COMMAND = 'node scripts/start-railway-service.mjs';
const EXPECTED_PR_START_COMMAND = `${EXPECTED_START_COMMAND} --pr-preview-app-safe-v1`;
const EXPECTED_HEALTHCHECK_PATH = '/readyz';
const EXPECTED_HEALTHCHECK_TIMEOUT_SECONDS = 300;
const EXPECTED_DRAINING_SECONDS = 60;
const RAILWAY_DRAINING_SECONDS_VARIABLE = 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS';
const EXPECTED_DOCKERFILE_CMD = 'CMD ["node", "scripts/start-railway-service.mjs"]';
const EXPECTED_DOCKERFILE_PRISMA_COPY = 'COPY prisma/ ./prisma/';
const EXPECTED_DOCKERFILE_VENDOR_COPY = 'COPY vendor/ ./vendor/';
const EXPECTED_DOCKERFILE_PRISMA_GENERATE = 'npx --yes prisma@5.22.0 generate --schema ./prisma/schema.prisma';
const EXPECTED_DOCKERFILE_RAILWAY_CLI_BIN_ENV = 'ENV RAILWAY_CLI_BIN=/usr/local/bin/railway-native';
const EXPECTED_DOCKERFILE_RAILWAY_CLI_INSTALL = 'npm install --global @railway/cli@4.30.2 --no-audit --no-fund';
const EXPECTED_DOCKERFILE_RAILWAY_CLI_MUSL_BINARY = 'railway-v4.30.2-x86_64-unknown-linux-musl.tar.gz';
const EXPECTED_DOCKERFILE_RAILWAY_CLI_SMOKE_TEST = '/usr/local/bin/railway-native --version';
const PROCESS_KIND_ENV = 'ARCANOS_PROCESS_KIND';
const REQUIRED_PRODUCTION_VARIABLES = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'ARCANOS_GPT_ACCESS_TOKEN',
  'ARCANOS_GPT_ACCESS_BASE_URL',
  'ARCANOS_GPT_ACCESS_SCOPES',
  'RAILWAY_ENVIRONMENT',
  PROCESS_KIND_ENV,
];
const DOCUMENTED_PRODUCTION_VARIABLES = [
  ...REQUIRED_PRODUCTION_VARIABLES,
  'RUN_WORKERS',
  'OPENAI_API_KEY_REQUIRED',
  'OPENAI_BASE_URL',
  'AI_MODEL',
  'GPT51_MODEL',
  'GPT5_MODEL',
  'WORKER_API_TIMEOUT_MS',
  'JOB_WORKER_CONCURRENCY',
  'JOB_WORKER_HEARTBEAT_MS',
  'JOB_WORKER_STALE_AFTER_MS',
  'JOB_WORKER_WATCHDOG_MS',
  'JOB_WORKER_WATCHDOG_IDLE_MS',
  'JOB_WORKER_MAX_RETRIES',
  'JOB_WORKER_RETRY_BASE_MS',
  'JOB_WORKER_RETRY_MAX_MS',
  'QUEUE_FAILED_JOB_CLEANUP_ENABLED',
  'QUEUE_FAILED_JOB_RETENTION_COUNT',
  'QUEUE_FAILED_JOB_CLEANUP_MIN_AGE_MS',
  'ARC_LOG_PATH',
  'ENABLE_ACTION_PLANS',
  'ENABLE_CLEAR_2',
];

/**
 * Read a project file as UTF-8 text.
 *
 * @param {string} filePath - Absolute file path to read.
 * @returns {Promise<string>} File contents.
 */
async function readProjectFile(filePath) {
  return fs.readFile(filePath, 'utf8');
}

/**
 * Read and parse railway.json.
 *
 * @returns {Promise<Record<string, unknown>>} Parsed configuration object.
 */
async function readRailwayConfig() {
  const raw = await readProjectFile(RAILWAY_CONFIG_PATH);
  return JSON.parse(raw);
}

/**
 * Read the root environment template.
 *
 * @returns {Promise<string>} Raw environment template text.
 */
async function readEnvTemplate() {
  return readProjectFile(ENV_TEMPLATE_PATH);
}

async function readDockerfile() {
  return readProjectFile(DOCKERFILE_PATH);
}

async function readRailwayIgnore() {
  return readProjectFile(RAILWAYIGNORE_PATH);
}

/**
 * Validate a string-backed boolean environment value.
 *
 * @param {unknown} value - Raw environment value candidate.
 * @returns {boolean} `true` when the value is one of the accepted boolean literals.
 */
export function isBooleanEnvironmentValue(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();

  //audit Assumption: Railway env values are string-backed even for boolean-like flags; risk: malformed literals bypass deploy intent and silently flip worker topology; invariant: boolean feature flags use an accepted string literal; handling: reject any non-boolean-like value.
  return normalizedValue === 'true' || normalizedValue === 'false' || normalizedValue === '1' || normalizedValue === '0';
}

/**
 * Validate the explicit process kind runtime contract.
 *
 * @param {unknown} value - Raw environment value candidate.
 * @returns {boolean} `true` when the value is an accepted explicit process kind or Railway pass-through.
 */
export function isProcessKindEnvironmentValue(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();
  return (
    normalizedValue === 'web'
    || normalizedValue === 'worker'
    || normalizedValue === `$${PROCESS_KIND_ENV.toLowerCase()}`
  );
}

/**
 * Validate core Railway deployment settings.
 *
 * @param {Record<string, unknown>} config - Parsed railway config.
 * @returns {string[]} Validation failures.
 */
export function validateConfig(config) {
  const errors = [];
  const build = (config.build ?? {});
  const deploy = (config.deploy ?? {});
  const environments = (config.environments ?? {});
  const productionEnvironment = (environments.production ?? {});
  const productionVariables = productionEnvironment.variables;
  const prEnvironment = (environments.pr ?? {});
  const prDeploy = prEnvironment.deploy;

  //audit Assumption: builder must be explicitly declared for deterministic deploys; risk: implicit platform defaults change behavior; invariant: builder is RAILPACK; handling: fail validation when mismatched.
  if (build.builder !== 'RAILPACK') {
    errors.push(`Expected build.builder to be "RAILPACK" but found "${String(build.builder ?? '')}"`);
  }

  //audit Assumption: build command must compile dist before start; risk: runtime missing compiled output; invariant: buildCommand exists and is non-empty; handling: reject empty/missing command.
  if (typeof build.buildCommand !== 'string' || build.buildCommand.trim().length === 0) {
    errors.push('build.buildCommand must be a non-empty string');
  }

  //audit Assumption: Railway runtime must have explicit start command; risk: startup ambiguity across environments; invariant: deploy.startCommand is non-empty; handling: fail when absent.
  if (typeof deploy.startCommand !== 'string' || deploy.startCommand.trim().length === 0) {
    errors.push('deploy.startCommand must be a non-empty string');
  }

  //audit Assumption: Railway must boot through the shared launcher so alias repair and worker health behavior stay consistent; risk: runtime drift between web and worker services; invariant: deploy.startCommand matches the shared launcher; handling: fail validation on drift.
  if (deploy.startCommand !== EXPECTED_START_COMMAND) {
    errors.push(`Expected deploy.startCommand to be "${EXPECTED_START_COMMAND}" but found "${String(deploy.startCommand ?? '')}"`);
  }

  //audit Assumption: Railway activation must establish role readiness rather than launcher/process liveness; risk: /health or /healthz can activate a worker before database/dispatcher bootstrap or a web process before critical dependencies are ready; invariant: the deployment gate uses /readyz; handling: fail on drift while preserving liveness endpoints for supervision.
  if (deploy.healthcheckPath !== EXPECTED_HEALTHCHECK_PATH) {
    errors.push(`Expected deploy.healthcheckPath to be "${EXPECTED_HEALTHCHECK_PATH}" but found "${String(deploy.healthcheckPath ?? '')}"`);
  }

  if (deploy.healthcheckTimeout !== EXPECTED_HEALTHCHECK_TIMEOUT_SECONDS) {
    errors.push(`Expected deploy.healthcheckTimeout to be ${EXPECTED_HEALTHCHECK_TIMEOUT_SECONDS} but found "${String(deploy.healthcheckTimeout ?? '')}"`);
  }

  //audit Assumption: Railway otherwise defaults the SIGTERM-to-SIGKILL interval to zero; risk: platform teardown can kill web request cancellation or worker claim/snapshot cleanup before cooperative shutdown completes; invariant: config-as-code provides the reviewed shared 60-second outer ceiling as the numeric type required by Railway's live schema; handling: reject missing, zero, string-backed, or drifted values.
  if (deploy.drainingSeconds !== EXPECTED_DRAINING_SECONDS) {
    errors.push(`Expected deploy.drainingSeconds to be the number ${EXPECTED_DRAINING_SECONDS} but found "${String(deploy.drainingSeconds ?? '')}"`);
  }

  //audit Assumption: Railway also accepts a provider-native service variable for the drain interval; risk: a tracked variable silently supersedes or conflicts with the canonical numeric deploy field; invariant: railway.json owns this setting only through deploy.drainingSeconds; handling: reject the provider-native variable in every tracked runtime-variable map, even when its string value appears equivalent.
  if (
    deploy.env
    && typeof deploy.env === 'object'
    && !Array.isArray(deploy.env)
    && Object.hasOwn(deploy.env, RAILWAY_DRAINING_SECONDS_VARIABLE)
  ) {
    errors.push(
      `deploy.env.${RAILWAY_DRAINING_SECONDS_VARIABLE} must be omitted; use deploy.drainingSeconds`,
    );
  }
  if (environments && typeof environments === 'object' && !Array.isArray(environments)) {
    for (const [environmentName, environmentConfig] of Object.entries(environments)) {
      const variables = (
        environmentConfig
        && typeof environmentConfig === 'object'
        && !Array.isArray(environmentConfig)
      )
        ? environmentConfig.variables
        : undefined;
      if (
        variables
        && typeof variables === 'object'
        && !Array.isArray(variables)
        && Object.hasOwn(variables, RAILWAY_DRAINING_SECONDS_VARIABLE)
      ) {
        errors.push(
          `environments.${environmentName}.variables.${RAILWAY_DRAINING_SECONDS_VARIABLE} must be omitted; use deploy.drainingSeconds`,
        );
      }
    }
  }

  //audit Assumption: every exact-named Railway environment takes precedence over root config; risk: a workflow target other than literal production can silently restore liveness activation or zero-second teardown while the root validator remains green; invariant: every non-PR environment inherits the root readiness path, timeout, and drain budget without redeclaring them; handling: reject those fields and the provider-native drain variable in every named environment deploy override.
  if (environments && typeof environments === 'object' && !Array.isArray(environments)) {
    for (const [environmentName, environmentConfig] of Object.entries(environments)) {
      if (environmentName === 'pr') {
        continue;
      }
      const environmentDeploy = (
        environmentConfig
        && typeof environmentConfig === 'object'
        && !Array.isArray(environmentConfig)
      )
        ? environmentConfig.deploy
        : undefined;
      if (environmentDeploy === undefined) {
        continue;
      }
      if (
        !environmentDeploy
        || typeof environmentDeploy !== 'object'
        || Array.isArray(environmentDeploy)
      ) {
        errors.push(`environments.${environmentName}.deploy must be an object when defined`);
        continue;
      }
      for (const field of ['healthcheckPath', 'healthcheckTimeout', 'drainingSeconds']) {
        if (Object.hasOwn(environmentDeploy, field)) {
          errors.push(`environments.${environmentName}.deploy.${field} must be omitted so ${environmentName} inherits deploy.${field}`);
        }
      }
      if (
        environmentDeploy.env
        && typeof environmentDeploy.env === 'object'
        && !Array.isArray(environmentDeploy.env)
        && Object.hasOwn(environmentDeploy.env, RAILWAY_DRAINING_SECONDS_VARIABLE)
      ) {
        errors.push(
          `environments.${environmentName}.deploy.env.${RAILWAY_DRAINING_SECONDS_VARIABLE} must be omitted; use deploy.drainingSeconds`,
        );
      }
    }
  }

  //audit Assumption: explicit restart policy is required for stable recovery behavior; risk: unbounded crash loops or no restart; invariant: ON_FAILURE policy present; handling: fail on mismatch.
  if (deploy.restartPolicyType !== 'ON_FAILURE') {
    errors.push(`Expected deploy.restartPolicyType to be "ON_FAILURE" but found "${String(deploy.restartPolicyType ?? '')}"`);
  }

  //audit Assumption: Railway deploy env should declare runtime role explicitly instead of inferring it from service naming; risk: unreviewed config drift boots the wrong process type; invariant: deploy.env.ARCANOS_PROCESS_KIND is present and either explicit or service-level pass-through; handling: fail validation on missing or malformed values.
  if (!isProcessKindEnvironmentValue(deploy.env?.[PROCESS_KIND_ENV])) {
    errors.push(
      `Expected deploy.env.${PROCESS_KIND_ENV} to be "web", "worker", or "$${PROCESS_KIND_ENV}" but found "${String(deploy.env?.[PROCESS_KIND_ENV] ?? '')}"`,
    );
  }

  //audit Assumption: production Railway variables must declare the runtime contract consumed by the app; risk: live environment drift leaves features implicitly disabled or model selection ambiguous; invariant: required keys are present under environments.production.variables; handling: fail validation when keys are absent.
  if (!productionVariables || typeof productionVariables !== 'object' || Array.isArray(productionVariables)) {
    errors.push('environments.production.variables must be an object');
  } else {
    const missingVariables = REQUIRED_PRODUCTION_VARIABLES.filter((key) => !(key in productionVariables));
    if (missingVariables.length > 0) {
      errors.push(`environments.production.variables missing required keys: ${missingVariables.join(', ')}`);
    }

    //audit Assumption: environment-level process role should also remain explicit for operators inspecting Railway variables; risk: silent fallback obscures whether a service should boot web or worker runtime; invariant: ARCANOS_PROCESS_KIND is a valid explicit value or Railway pass-through; handling: fail validation on malformed values.
    if (!isProcessKindEnvironmentValue(productionVariables[PROCESS_KIND_ENV])) {
      errors.push(
        `Expected environments.production.variables.${PROCESS_KIND_ENV} to be "web", "worker", or "$${PROCESS_KIND_ENV}" but found "${String(productionVariables[PROCESS_KIND_ENV] ?? '')}"`,
      );
    }
  }

  //audit Assumption: Railway applies the special `environments.pr` override to every native PR service; risk: inherited production configuration starts providers, workers, bridges, schedulers, or migrations before preview isolation is reviewed; invariant: native PR deploys enter the health-only launcher with no pre-deploy command, cron, or restart loop; handling: schema-lock the exact passive override.
  if (!prDeploy || typeof prDeploy !== 'object' || Array.isArray(prDeploy)) {
    errors.push('environments.pr.deploy must be an object');
  } else {
    if (prDeploy.startCommand !== EXPECTED_PR_START_COMMAND) {
      errors.push(`Expected environments.pr.deploy.startCommand to be "${EXPECTED_PR_START_COMMAND}" but found "${String(prDeploy.startCommand ?? '')}"`);
    }
    if (prDeploy.preDeployCommand !== null) {
      errors.push('environments.pr.deploy.preDeployCommand must be null');
    }
    if (prDeploy.healthcheckPath !== EXPECTED_HEALTHCHECK_PATH) {
      errors.push(`Expected environments.pr.deploy.healthcheckPath to be "${EXPECTED_HEALTHCHECK_PATH}" but found "${String(prDeploy.healthcheckPath ?? '')}"`);
    }
    if (prDeploy.healthcheckTimeout !== EXPECTED_HEALTHCHECK_TIMEOUT_SECONDS) {
      errors.push(`Expected environments.pr.deploy.healthcheckTimeout to be ${EXPECTED_HEALTHCHECK_TIMEOUT_SECONDS} but found "${String(prDeploy.healthcheckTimeout ?? '')}"`);
    }
    //audit Assumption: the PR override inherits the reviewed root drain budget; risk: an environment-local zero or string value bypasses cooperative preview teardown while root validation stays green; invariant: environments.pr.deploy never redeclares drainingSeconds; handling: reject the field even when it duplicates the root value.
    if (Object.hasOwn(prDeploy, 'drainingSeconds')) {
      errors.push('environments.pr.deploy.drainingSeconds must be omitted so PR deployments inherit deploy.drainingSeconds');
    }
    if (
      prDeploy.env
      && typeof prDeploy.env === 'object'
      && !Array.isArray(prDeploy.env)
      && Object.hasOwn(prDeploy.env, RAILWAY_DRAINING_SECONDS_VARIABLE)
    ) {
      errors.push(
        `environments.pr.deploy.env.${RAILWAY_DRAINING_SECONDS_VARIABLE} must be omitted; use deploy.drainingSeconds`,
      );
    }
    if (prDeploy.cronSchedule !== null) {
      errors.push('environments.pr.deploy.cronSchedule must be null');
    }
    if (prDeploy.restartPolicyType !== 'NEVER') {
      errors.push(`Expected environments.pr.deploy.restartPolicyType to be "NEVER" but found "${String(prDeploy.restartPolicyType ?? '')}"`);
    }
    if (prDeploy.restartPolicyMaxRetries !== null) {
      errors.push(`Expected environments.pr.deploy.restartPolicyMaxRetries to be null but found "${String(prDeploy.restartPolicyMaxRetries ?? '')}"`);
    }
  }

  if ('variables' in prEnvironment) {
    errors.push('environments.pr.variables is forbidden; Railway PR overrides must remain schema-compatible build/deploy settings only');
  }

  return errors;
}

/**
 * Extract all declared environment keys from the root example template.
 *
 * @param {string} templateRaw - Raw `.env.example` contents.
 * @returns {Set<string>} Declared environment keys.
 */
export function extractEnvTemplateKeys(templateRaw) {
  const environmentKeys = new Set();

  for (const rawLine of templateRaw.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith('##')) {
      continue;
    }

    const normalizedLine = trimmedLine.startsWith('#') ? trimmedLine.slice(1).trim() : trimmedLine;
    const match = /^([A-Z0-9_]+)\s*=/.exec(normalizedLine);
    if (match) {
      environmentKeys.add(match[1]);
    }
  }

  return environmentKeys;
}

/**
 * Validate that the local environment template documents the Railway contract.
 *
 * @param {Set<string>} documentedKeys - Keys found in `.env.example`.
 * @returns {string[]} Validation failures.
 */
export function validateEnvTemplate(documentedKeys) {
  const errors = [];
  const missingTemplateKeys = DOCUMENTED_PRODUCTION_VARIABLES.filter((key) => !documentedKeys.has(key));

  //audit Assumption: local operators use `.env.example` as the canonical runtime surface; risk: undocumented keys cause hard-to-reproduce prod/local drift; invariant: all high-impact Railway variables are documented; handling: fail validation when template keys are missing.
  if (missingTemplateKeys.length > 0) {
    errors.push(`.env.example missing documented keys: ${missingTemplateKeys.join(', ')}`);
  }

  return errors;
}

export function validateDockerfile(dockerfileRaw) {
  const errors = [];

  //audit Assumption: Dockerfile-backed Railway deploys must boot through the same launcher as railway.json; risk: image CMD bypasses service-role logic and starts web instances with worker settings; invariant: Dockerfile CMD points at the shared Railway launcher; handling: fail validation when the launcher command is absent.
  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_CMD)) {
    errors.push(`Dockerfile must include ${EXPECTED_DOCKERFILE_CMD}`);
  }

  //audit Assumption: Railway images that expose Prisma-backed routes must include the schema during build and generate the client before pruning dev tooling; risk: routes importing @prisma/client fail at runtime even though the service boots successfully; invariant: Dockerfile copies prisma/ and runs Prisma client generation; handling: fail validation when either build step is absent.
  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_PRISMA_COPY)) {
    errors.push(`Dockerfile must include ${EXPECTED_DOCKERFILE_PRISMA_COPY}`);
  }

  //audit Assumption: npm lockfile file: dependencies under vendor/ must be present before npm ci; risk: Railway image builds fail even though local installs pass; invariant: Dockerfile copies vendor before dependency install; handling: fail validation when the copy is absent.
  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_VENDOR_COPY)) {
    errors.push(`Dockerfile must include ${EXPECTED_DOCKERFILE_VENDOR_COPY}`);
  }

  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_PRISMA_GENERATE)) {
    errors.push(`Dockerfile must include ${EXPECTED_DOCKERFILE_PRISMA_GENERATE}`);
  }

  //audit Assumption: the secure control-plane Railway adapter executes an allowlisted Railway CLI binary inside the runtime image; risk: live preview accepts the operation but fails every read-only Railway command at runtime; invariant: Dockerfile installs a pinned Railway CLI and exposes its binary path explicitly; handling: fail validation when either runtime contract is absent.
  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_RAILWAY_CLI_BIN_ENV)) {
    errors.push(`Dockerfile must include ${EXPECTED_DOCKERFILE_RAILWAY_CLI_BIN_ENV}`);
  }

  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_RAILWAY_CLI_INSTALL)) {
    errors.push(`Dockerfile must include ${EXPECTED_DOCKERFILE_RAILWAY_CLI_INSTALL}`);
  }

  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_RAILWAY_CLI_MUSL_BINARY)) {
    errors.push(`Dockerfile must install the pinned musl Railway CLI binary ${EXPECTED_DOCKERFILE_RAILWAY_CLI_MUSL_BINARY}`);
  }

  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_RAILWAY_CLI_SMOKE_TEST)) {
    errors.push(`Dockerfile must smoke test ${EXPECTED_DOCKERFILE_RAILWAY_CLI_SMOKE_TEST}`);
  }

  return errors;
}

export function validateRailwayIgnore(railwayIgnoreRaw) {
  const errors = [];
  const ignoredVendor = railwayIgnoreRaw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .some((line) => line === 'vendor/' || line === '/vendor/' || line === 'vendor' || line === '/vendor');

  //audit Assumption: Railway build context must include vendored npm file dependencies referenced by package-lock; risk: deploy build fails before app startup; invariant: .railwayignore does not exclude vendor/; handling: fail validation when vendor is ignored.
  if (ignoredVendor) {
    errors.push('.railwayignore must not exclude vendor/ because package-lock references vendored npm file dependencies');
  }

  return errors;
}

async function main() {
  try {
    const [config, envTemplateRaw, dockerfileRaw, railwayIgnoreRaw] = await Promise.all([
      readRailwayConfig(),
      readEnvTemplate(),
      readDockerfile(),
      readRailwayIgnore(),
    ]);
    const errors = [
      ...validateConfig(config),
      ...validateEnvTemplate(extractEnvTemplateKeys(envTemplateRaw)),
      ...validateDockerfile(dockerfileRaw),
      ...validateRailwayIgnore(railwayIgnoreRaw),
    ];

    //audit Assumption: any compatibility error should block CI/deploy; risk: shipping invalid platform config; invariant: zero validation errors required; handling: print all errors and exit 1.
    if (errors.length > 0) {
      console.error('Railway compatibility validation failed:');
      for (const error of errors) {
        console.error(`- ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log('Railway compatibility validation passed.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Railway compatibility validation crashed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
