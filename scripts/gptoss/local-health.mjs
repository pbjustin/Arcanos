#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { checkLocalGptossHealth, readBridgeConfig } from './model-clients.mjs';

async function main() {
  const config = readBridgeConfig();
  const result = await checkLocalGptossHealth({ config });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
