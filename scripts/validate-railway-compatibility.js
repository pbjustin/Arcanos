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
const EXPECTED_START_COMMAND = 'node scripts/start-railway-service.mjs';
const EXPECTED_HEALTHCHECK_PATH = '/health';
const EXPECTED_DOCKERFILE_CMD = 'CMD ["node", "scripts/start-railway-service.mjs"]';
const EXPECTED_DOCKERFILE_PRISMA_COPY = 'COPY prisma/ ./prisma/';
const EXPECTED_DOCKERFILE_PRISMA_GENERATE = 'npx --yes prisma@5.22.0 generate --schema ./prisma/schema.prisma';
const REQUIRED_PRODUCTION_VARIABLES = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'RAILWAY_ENVIRONMENT',
  'RUN_WORKERS',
];
const DOCUMENTED_PRODUCTION_VARIABLES = [
  ...REQUIRED_PRODUCTION_VARIABLES,
  'OPENAI_BASE_URL',
  'AI_MODEL',
  'GPT51_MODEL',
  'GPT5_MODEL',
  'WORKER_API_TIMEOUT_MS',
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

  //audit Assumption: Railway deploy env should declare worker topology explicitly instead of inheriting a runtime default; risk: unreviewed config drift changes whether the web service starts in-process workers; invariant: deploy.env.RUN_WORKERS is present and boolean-like; handling: fail validation on missing or malformed values.
  if (!isBooleanEnvironmentValue(deploy.env?.RUN_WORKERS)) {
    errors.push(
      `Expected deploy.env.RUN_WORKERS to be one of "true", "false", "1", or "0" but found "${String(deploy.env?.RUN_WORKERS ?? '')}"`,
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

    //audit Assumption: environment-level worker topology should also remain explicit for operators inspecting Railway variables; risk: silent fallback to runtime defaults obscures service behavior; invariant: RUN_WORKERS is a boolean-like string when present in production variables; handling: fail validation on malformed values.
    if (!isBooleanEnvironmentValue(productionVariables.RUN_WORKERS)) {
      errors.push(
        `Expected environments.production.variables.RUN_WORKERS to be one of "true", "false", "1", or "0" but found "${String(productionVariables.RUN_WORKERS ?? '')}"`,
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

  if (!dockerfileRaw.includes(EXPECTED_DOCKERFILE_PRISMA_GENERATE)) {
    errors.push(`Dockerfile must include ${EXPECTED_DOCKERFILE_PRISMA_GENERATE}`);
  }

  return errors;
}

async function main() {
  try {
    const [config, envTemplateRaw, dockerfileRaw] = await Promise.all([
      readRailwayConfig(),
      readEnvTemplate(),
      readDockerfile(),
    ]);
    const errors = [
      ...validateConfig(config),
      ...validateEnvTemplate(extractEnvTemplateKeys(envTemplateRaw)),
      ...validateDockerfile(dockerfileRaw),
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
