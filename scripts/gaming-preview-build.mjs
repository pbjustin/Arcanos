#!/usr/bin/env node
// Fixed trusted profile over the shared secretless artifact implementation.
import { readFileSync, lstatSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildPreviewArtifact, validateGamingBuildReceipt, verifyImageArchive } from './stacked-draft-preview-build.mjs';

export { validateGamingBuildReceipt } from './stacked-draft-preview-build.mjs';

function readJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('GAMING_BUILD_INPUT_INVALID');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function runGamingPreviewBuild(args = process.argv.slice(2)) {
  const [mode, authorizationFile, outputOrReceipt, imageFile] = args;
  if (!['build', 'verify'].includes(mode) || args.length !== (mode === 'build' ? 3 : 4)) {
    throw new Error('GAMING_BUILD_ARGUMENT_INVALID');
  }
  const authorization = readJson(authorizationFile);
  if (mode === 'build') return buildPreviewArtifact({ authorization, outputDirectory: outputOrReceipt, profile: 'gaming' });
  const receipt = readJson(outputOrReceipt);
  validateGamingBuildReceipt(receipt, authorization);
  return verifyImageArchive(imageFile, receipt, authorization);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runGamingPreviewBuild(); }
  catch (error) {
    console.error(/^(?:GAMING|STACKED)_BUILD_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'GAMING_BUILD_FAILED');
    process.exitCode = 1;
  }
}
