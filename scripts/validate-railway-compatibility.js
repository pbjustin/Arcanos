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

const PROJECT_ROOT = process.cwd();
const RAILWAY_CONFIG_PATH = path.join(PROJECT_ROOT, 'railway.json');

/**
 * Read and parse railway.json.
 *
 * @returns {Promise<Record<string, unknown>>} Parsed configuration object.
 */
async function readRailwayConfig() {
  const raw = await fs.readFile(RAILWAY_CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Validate core Railway deployment settings.
 *
 * @param {Record<string, unknown>} config - Parsed railway config.
 * @returns {string[]} Validation failures.
 */
function validateConfig(config) {
  const errors = [];
  const build = (config.build ?? {});
  const deploy = (config.deploy ?? {});

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

  //audit Assumption: healthcheck path drives Railway restarts; risk: unhealthy services marked healthy; invariant: path is /health; handling: fail on drift.
  if (deploy.healthcheckPath !== '/health') {
    errors.push(`Expected deploy.healthcheckPath to be "/health" but found "${String(deploy.healthcheckPath ?? '')}"`);
  }

  //audit Assumption: explicit restart policy is required for stable recovery behavior; risk: unbounded crash loops or no restart; invariant: ON_FAILURE policy present; handling: fail on mismatch.
  if (deploy.restartPolicyType !== 'ON_FAILURE') {
    errors.push(`Expected deploy.restartPolicyType to be "ON_FAILURE" but found "${String(deploy.restartPolicyType ?? '')}"`);
  }

  return errors;
}

async function main() {
  try {
    const config = await readRailwayConfig();
    const errors = validateConfig(config);

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

await main();
