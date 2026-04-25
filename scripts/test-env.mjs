import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testEnvPath = path.join(projectRoot, '.env.test');

process.env.NODE_ENV = 'test';

dotenv.config({
  path: testEnvPath,
  override: true
});

const productionOnlyKeys = [
  'ARCANOS_PROCESS_KIND',
  'ARCANOS_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS',
  'DATABASE_PRIVATE_URL',
  'DATABASE_URL',
  'GPT_ROUTE_HARD_TIMEOUT_MS',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGUSER',
  'POSTGRES_DATABASE',
  'POSTGRES_DB',
  'POSTGRES_HOST',
  'POSTGRES_PASSWORD',
  'POSTGRES_PORT',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL',
  'POSTGRES_USER',
  'RAILWAY_API_TOKEN',
  'RAILWAY_DEPLOYMENT_ID',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_PRIVATE_DOMAIN',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_PUBLIC_DOMAIN',
  'RAILWAY_REPLICA_ID',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_SERVICE_NAME',
  'RAILWAY_STATIC_URL',
  'RAILWAY_TOKEN',
  'REDIS_HOST',
  'REDIS_PASSWORD',
  'REDIS_PORT',
  'REDIS_URL',
  'REDIS_USER',
  'REDISHOST',
  'REDISPASSWORD',
  'REDISPORT',
  'REDISUSER'
];

for (const key of productionOnlyKeys) {
  delete process.env[key];
}

const testDefaults = {
  AI_MODEL: 'gpt-4o-mini',
  ALLOW_MOCK_OPENAI: 'true',
  DISABLE_EXTERNAL_CALLS: 'true',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
  OPENAI_API_KEY: 'test-openai-api-key',
  REDIS_SHARED_METRICS_ENABLED: 'false',
  RUN_WORKERS: 'false',
  USE_MOCK_SERVICES: 'true'
};

for (const [key, value] of Object.entries(testDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
