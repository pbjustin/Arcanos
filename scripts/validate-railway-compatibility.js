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
const EXPECTED_HEALTHCHECK_PATH = '/health';
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

  //audit Assumption: Railway should probe the stable service-availability endpoint; risk: probing stricter diagnostics like /healthz can fail healthy deployments on non-critical readiness drift; invariant: deploy health checks use /health; handling: fail on drift.
  if (deploy.healthcheckPath !== EXPECTED_HEALTHCHECK_PATH) {
    errors.push(`Expected deploy.healthcheckPath to be "${EXPECTED_HEALTHCHECK_PATH}" but found "${String(deploy.healthcheckPath ?? '')}"`);
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
