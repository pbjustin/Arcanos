#!/usr/bin/env node

/**
 * Backend/CLI contract manifest validator.
 *
 * Purpose:
 * - Enforce centralized, versioned contract metadata between TypeScript backend routes and Python daemon bindings.
 * - Fail fast in CI when endpoint bindings drift across stacks.
 *
 * Inputs/Outputs:
 * - Reads contract manifest and source files from repository paths.
 * - Exits code 0 when all checks pass, code 1 when violations exist.
 *
 * Edge cases:
 * - Reports malformed JSON, missing files, and missing bindings without throwing unhandled exceptions.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const CONTRACT_MANIFEST_PATH = path.join(ROOT, 'contracts', 'backend_cli_contract.v1.json');
const EXPECTED_CONTRACT_VERSION = '1.0.0';
const REQUIRED_ENDPOINTS = ['/ask', '/api/vision', '/api/transcribe', '/api/update'];
const PYTHON_BACKEND_CLIENT_INIT_PATH = path.join(
  ROOT,
  'daemon-python',
  'arcanos',
  'backend_client',
  '__init__.py',
);

/**
 * Append a validation finding when a condition fails.
 *
 * @param {boolean} condition - Condition to verify.
 * @param {string} message - Failure message when condition is false.
 * @param {string[]} findings - Accumulator for findings.
 */
function assertCondition(condition, message, findings) {
  if (!condition) {
    findings.push(message);
  }
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} filePath - Absolute file path.
 * @returns {Promise<unknown>} Parsed JSON value.
 */
async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Validate manifest structure and required endpoint keys.
 *
 * @param {string[]} findings - Accumulator for findings.
 * @returns {Promise<Record<string, unknown> | null>} Manifest object when parse succeeds.
 */
async function validateManifest(findings) {
  //audit Assumption: one canonical manifest path defines backend/CLI contract ownership; Failure risk: duplicated contracts drifting independently; Invariant: manifest exists at repository-level contracts path; Handling strategy: fail validation if missing.
  try {
    await fs.access(CONTRACT_MANIFEST_PATH);
  } catch {
    findings.push(`Missing contract manifest: ${CONTRACT_MANIFEST_PATH}`);
    return null;
  }

  let manifest;
  try {
    manifest = /** @type {Record<string, unknown>} */ (await readJson(CONTRACT_MANIFEST_PATH));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(`Invalid contract manifest JSON: ${message}`);
    return null;
  }

  const contractVersion = manifest.contractVersion;
  //audit Assumption: contract version mismatch implies incompatible runtime assumptions; Failure risk: schema drift across TypeScript and Python paths; Invariant: expected and declared version match exactly; Handling strategy: fail on mismatch.
  assertCondition(
    contractVersion === EXPECTED_CONTRACT_VERSION,
    `Contract version mismatch: expected ${EXPECTED_CONTRACT_VERSION}, found ${String(contractVersion)}`,
    findings,
  );

  const endpoints = manifest.endpoints;
  assertCondition(
    typeof endpoints === 'object' && endpoints !== null && !Array.isArray(endpoints),
    'Manifest endpoints must be a non-empty object',
    findings,
  );

  if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) {
    return manifest;
  }

  for (const endpoint of REQUIRED_ENDPOINTS) {
    assertCondition(
      Object.prototype.hasOwnProperty.call(endpoints, endpoint),
      `Manifest missing required endpoint: ${endpoint}`,
      findings,
    );
  }

  return manifest;
}

/**
 * Validate TypeScript route file bindings declared in the manifest.
 *
 * @param {Record<string, unknown>} manifest - Parsed manifest object.
 * @param {string[]} findings - Accumulator for findings.
 * @returns {Promise<void>}
 */
async function validateTypeScriptBindings(manifest, findings) {
  const endpoints = manifest.endpoints;
  if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) {
    return;
  }

  for (const [endpointPath, endpointDefinitionUnknown] of Object.entries(endpoints)) {
    if (!endpointDefinitionUnknown || typeof endpointDefinitionUnknown !== 'object' || Array.isArray(endpointDefinitionUnknown)) {
      findings.push(`Endpoint definition must be an object: ${endpointPath}`);
      continue;
    }

    const endpointDefinition = /** @type {{ tsRouteFile?: unknown }} */ (endpointDefinitionUnknown);
    const tsRouteFile = endpointDefinition.tsRouteFile;
    if (typeof tsRouteFile !== 'string') {
      findings.push(`Endpoint is missing tsRouteFile: ${endpointPath}`);
      continue;
    }

    const tsRoutePath = path.join(ROOT, tsRouteFile);
    try {
      await fs.access(tsRoutePath);
    } catch {
      findings.push(`Declared route file does not exist for ${endpointPath}: ${tsRouteFile}`);
      continue;
    }

    const routeSource = await fs.readFile(tsRoutePath, 'utf8');
    //audit Assumption: manifest endpoint path should be visible in declared route source; Failure risk: stale mapping to unrelated file; Invariant: endpoint literal exists in route file; Handling strategy: fail when endpoint text not found.
    assertCondition(
      routeSource.includes(endpointPath),
      `Route file does not reference endpoint ${endpointPath}: ${tsRouteFile}`,
      findings,
    );
  }
}

/**
 * Validate Python backend client method bindings declared in the manifest.
 *
 * @param {Record<string, unknown>} manifest - Parsed manifest object.
 * @param {string[]} findings - Accumulator for findings.
 * @returns {Promise<void>}
 */
async function validatePythonBindings(manifest, findings) {
  let backendClientSource = '';
  try {
    backendClientSource = await fs.readFile(PYTHON_BACKEND_CLIENT_INIT_PATH, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(`Unable to read Python backend client source: ${message}`);
    return;
  }

  const endpoints = manifest.endpoints;
  if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) {
    return;
  }

  for (const [endpointPath, endpointDefinitionUnknown] of Object.entries(endpoints)) {
    if (!endpointDefinitionUnknown || typeof endpointDefinitionUnknown !== 'object' || Array.isArray(endpointDefinitionUnknown)) {
      continue;
    }

    const endpointDefinition = /** @type {{ pythonClientMethods?: unknown }} */ (endpointDefinitionUnknown);
    const pythonClientMethods = endpointDefinition.pythonClientMethods;
    if (!Array.isArray(pythonClientMethods)) {
      findings.push(`Endpoint pythonClientMethods must be an array: ${endpointPath}`);
      continue;
    }

    for (const methodName of pythonClientMethods) {
      if (typeof methodName !== 'string') {
        findings.push(`Endpoint pythonClientMethods contains non-string value: ${endpointPath}`);
        continue;
      }

      //audit Assumption: each manifest-declared Python binding must exist as a callable on BackendApiClient; Failure risk: runtime attribute errors; Invariant: method symbol present in source; Handling strategy: static method signature check.
      assertCondition(
        backendClientSource.includes(`def ${methodName}(`),
        `Python backend client is missing method from manifest: ${methodName}`,
        findings,
      );
    }
  }
}

/**
 * Program entrypoint.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const findings = [];
  const manifest = await validateManifest(findings);

  if (manifest) {
    await validateTypeScriptBindings(manifest, findings);
    await validatePythonBindings(manifest, findings);
  }

  //audit Assumption: any finding indicates contract drift risk and should block CI; Failure risk: latent runtime incompatibility reaching production; Invariant: zero findings required; Handling strategy: print findings and exit non-zero.
  if (findings.length > 0) {
    console.error('\n[validate-backend-cli-contract] FAIL');
    for (const finding of findings) {
      console.error(` - ${finding}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[validate-backend-cli-contract] PASS');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[validate-backend-cli-contract] ERROR: ${message}`);
  process.exitCode = 1;
});

