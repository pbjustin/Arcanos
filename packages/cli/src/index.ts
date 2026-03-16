#!/usr/bin/env node

import { runCli } from "./cli.js";

/**
 * Executes the package CLI entrypoint.
 * Inputs: process argv, stdout, and stderr.
 * Outputs: resolves when the process exit code has been assigned.
 * Edge cases: any unhandled promise rejection is converted into a non-zero exit code.
 */
async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2), process.stdout, process.stderr);
  process.exitCode = exitCode;
}

void main();
