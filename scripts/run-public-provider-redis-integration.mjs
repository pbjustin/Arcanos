import { spawnSync } from 'node:child_process';
import process from 'node:process';

const requiredEnvironmentNames = [
  'PUBLIC_PROVIDER_TEST_REDIS_URL',
  'PUBLIC_PROVIDER_TEST_REDIS_CONFIRM_DISPOSABLE',
];
const missingEnvironmentNames = requiredEnvironmentNames.filter((name) => (
  typeof process.env[name] !== 'string' || process.env[name].length === 0
));

if (missingEnvironmentNames.length > 0) {
  console.error(
    `Public-provider Redis integration requires: ${missingEnvironmentNames.join(', ')}`
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  'scripts/run-jest.mjs',
  '--runTestsByPath',
  'tests/integration/public-provider-rate-limit-redis.integration.test.ts',
  '--coverage=false',
  '--runInBand',
], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
