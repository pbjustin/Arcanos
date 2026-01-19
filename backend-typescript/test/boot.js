const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const rootDir = process.cwd();
const bootLogPath = path.join(rootDir, 'boot.log');
const bootFailPath = path.join(rootDir, 'boot-fail.log');

function writeLog(filePath, lines) {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function main() {
  const lines = [];
  const log = (message) => {
    lines.push(`[${new Date().toISOString()}] ${message}`);
  };

  dotenv.config({ path: path.join(rootDir, '.env') });

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  ensure(nodeMajor >= 18, `Node.js version too low: ${process.versions.node}`);
  log(`Node.js OK: ${process.versions.node}`);

  const modulesDir = path.join(rootDir, 'modules');
  const manifestPath = path.join(modulesDir, 'manifest.json');
  ensure(fs.existsSync(manifestPath), 'modules/manifest.json is missing');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ensure(isPlainObject(manifest), 'modules/manifest.json must be an object');
  ensure(Array.isArray(manifest.modules), 'modules manifest must include modules array');
  ensure(manifest.modules.length > 0, 'modules manifest must list at least one module');

  for (const entry of manifest.modules) {
    ensure(isPlainObject(entry), 'module entry must be an object');
    ensure(typeof entry.id === 'string' && entry.id.trim().length > 0, 'module entry missing id');
    ensure(typeof entry.path === 'string' && entry.path.trim().length > 0, 'module entry missing path');

    const modulePath = path.join(modulesDir, entry.path);
    ensure(fs.existsSync(modulePath), `module file missing: ${entry.path}`);
    const moduleData = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
    ensure(isPlainObject(moduleData), `module file invalid: ${entry.path}`);
    ensure(typeof moduleData.id === 'string', `module id missing in ${entry.path}`);
    ensure(typeof moduleData.name === 'string', `module name missing in ${entry.path}`);
  }
  log(`Modules OK: ${manifest.modules.length} module(s)`);

  const mockPath = path.join(modulesDir, '.mock');
  fs.writeFileSync(mockPath, JSON.stringify({ ok: true, at: Date.now() }), 'utf8');
  const mockData = JSON.parse(fs.readFileSync(mockPath, 'utf8'));
  ensure(mockData.ok === true, 'module read/write mock failed');
  fs.unlinkSync(mockPath);
  log('Module read/write mock OK');

  const fallbackPath = path.join(rootDir, 'relay', 'fallback.js');
  const { buildFallbackResponse } = require(fallbackPath);
  const fallbackRuns = await Promise.all(
    Array.from({ length: 5 }).map((_, index) => new Promise((resolve) => {
      setImmediate(() => resolve(buildFallbackResponse('test_fallback', `case_${index}`)));
    }))
  );
  ensure(fallbackRuns.length === 5, 'fallback run count mismatch');
  ensure(fallbackRuns[0] !== fallbackRuns[1], 'fallback responses share memory');
  ensure(fallbackRuns[0].meta !== fallbackRuns[1].meta, 'fallback meta objects share memory');
  const fallbackIds = new Set(fallbackRuns.map((item) => item.requestId));
  ensure(fallbackIds.size === fallbackRuns.length, 'fallback requestId not unique');
  log('Fallback handlers OK (memory safe + async isolated)');

  const openaiModule = require('openai');
  const OpenAI = openaiModule.default || openaiModule;
  const apiKey = process.env.OPENAI_API_KEY;
  ensure(apiKey, 'OPENAI_API_KEY is not set');
  const openaiClient = new OpenAI({ apiKey });
  log('OpenAI client initialized');

  const testModel = process.env.OPENAI_TEST_MODEL || 'gpt-4o-mini';
  const completion = await openaiClient.chat.completions.create({
    model: testModel,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1
  });
  const pingResponse = completion.choices?.[0]?.message?.content || '';
  log(`OpenAI ping OK (${testModel}): ${pingResponse ? 'response received' : 'empty response'}`);

  const schemaLoaderPath = path.join(rootDir, 'relay', 'schema-loader.js');
  const { getRelaySchema, schemaPath } = require(schemaLoaderPath);
  const { printSchema } = require('graphql');
  const schemaBefore = getRelaySchema();
  const hashBefore = crypto.createHash('sha256').update(printSchema(schemaBefore)).digest('hex');

  const newTimestamp = new Date(Date.now() + 1000);
  fs.utimesSync(schemaPath, newTimestamp, newTimestamp);
  const schemaAfter = getRelaySchema();
  const hashAfter = crypto.createHash('sha256').update(printSchema(schemaAfter)).digest('hex');
  ensure(schemaBefore !== schemaAfter, 'schema hot-reload did not create a new instance');
  log(`Schema hot-reload OK (hash ${hashBefore === hashAfter ? 'stable' : 'updated'})`);

  const moduleStorePath = path.join(rootDir, 'relay', 'store', 'modules.js');
  const { getModulesHash } = require(moduleStorePath);
  const moduleHash = getModulesHash();
  log(`Module hash: ${moduleHash}`);

  writeLog(bootLogPath, lines);
  return moduleHash;
}

main().catch((error) => {
  const lines = [
    `[${new Date().toISOString()}] BOOT FAILED`,
    error && error.stack ? error.stack : String(error)
  ];
  writeLog(bootFailPath, lines);
  process.exit(1);
});
