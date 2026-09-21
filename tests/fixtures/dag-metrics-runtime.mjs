import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Run in a fresh process after the reviewed repository's root build.
// This proves the compiled task-runner path with local artifacts, not a live queue.
const PAIRS_PER_BATCH = 64;
const BATCH_COUNT = 2;
const TIME_LIMIT_MS = 30_000;
const EXPECTED_FAILURE = 'DAG_METRICS_FIXTURE_EXPECTED_FAILURE';
const DURATION_KEYS = ['node_execution', 'node_execution_failed'];
const CONNECTION_ENV_KEYS = [
  'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_HOST', 'POSTGRES_PORT',
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_DATABASE',
  'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_USER', 'REDIS_PASSWORD',
  'REDISHOST', 'REDISPORT', 'REDISUSER', 'REDISPASSWORD'
];

function containedPath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative), 'DAG_METRICS_FIXTURE_PATH_ESCAPE');
  return resolved;
}

function parseRoot() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--repo-root'
    && args[1].trim()), 'DAG_METRICS_FIXTURE_ARGUMENTS');
  return path.resolve(args[1] ?? process.cwd());
}

async function runFixture() {
  assert.notEqual(process.env.NODE_ENV, 'production', 'DAG_METRICS_FIXTURE_PRODUCTION_FORBIDDEN');
  assert.ok(CONNECTION_ENV_KEYS.every(key => !process.env[key]?.trim()),
    'DAG_METRICS_FIXTURE_CONNECTION_CONFIGURED');
  const repositoryRoot = await fs.realpath(parseRoot());
  const importCompiled = relativePath => import(pathToFileURL(
    containedPath(repositoryRoot, path.join('dist', relativePath))
  ).href);
  const startedAt = performance.now();
  const abortController = new AbortController();
  const deadline = setTimeout(() => {
    abortController.abort(new Error('DAG_METRICS_FIXTURE_TIMEOUT'));
  }, TIME_LIMIT_MS);
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const originalArtifactDirectory = process.env.TRINITY_ARTIFACT_STORE_DIR;
  const originalArtifactBackend = process.env.TRINITY_ARTIFACT_STORE_BACKEND;
  let networkAttempts = 0;
  let providerAttempts = 0;
  let temporaryRoot;
  let temporaryParent;
  let cleaned = false;
  let proof;
  const denyNetwork = () => {
    networkAttempts += 1;
    throw new Error('DAG_METRICS_FIXTURE_NETWORK_FORBIDDEN');
  };
  globalThis.fetch = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;

  try {
    const [runnerModule, registryModule, metricsModule, healthModule, artifactModule, schemaModule] =
      await Promise.all([
        importCompiled('workers/taskRunners.js'),
        importCompiled('agents/agentManager.js'),
        importCompiled('utils/metrics.js'),
        importCompiled('platform/logging/logger.js'),
        importCompiled('dag/artifactStore.js'),
        importCompiled('jobs/jobSchema.js')
      ]);
    const { runDagNodeJob } = runnerModule;
    const { dagAgentManager } = registryModule;
    const { dagMetrics } = metricsModule;
    const { healthMetrics } = healthModule;
    const { createDagArtifactStore, createArtifactReferenceOutput } = artifactModule;
    const { buildDagNodeJobInput, parseDagNodeJobInput } = schemaModule;

    temporaryParent = await fs.realpath(os.tmpdir());
    temporaryRoot = await fs.realpath(await fs.mkdtemp(
      path.join(temporaryParent, 'arcanos-dag-metrics-')
    ));
    const artifactRoot = containedPath(temporaryRoot, 'artifacts');
    process.env.TRINITY_ARTIFACT_STORE_BACKEND = 'filesystem';
    process.env.TRINITY_ARTIFACT_STORE_DIR = artifactRoot;
    const artifactStore = createDagArtifactStore({
      TRINITY_ARTIFACT_STORE_BACKEND: 'filesystem',
      TRINITY_ARTIFACT_STORE_DIR: artifactRoot
    });
    const artifacts = [];
    const checkpoints = [];
    const storage = dagMetrics.durationsMs;
    assert.ok(storage instanceof Map && storage.size === 0, 'DAG_METRICS_FIXTURE_NOT_FRESH');
    assert.deepEqual(dagMetrics.snapshot(), { counters: {}, gauges: {}, durationsMs: {} },
      'DAG_METRICS_FIXTURE_NOT_FRESH');

    let clockMs = 1_000;
    Date.now = () => clockMs;
    const successOutput = payload => ({
      result: 'Completed metrics runtime fixture.',
      summary: 'Completed metrics runtime fixture.',
      fixtureSequence: payload.sequence,
      tokensUsed: payload.tokensUsed
    });
    dagAgentManager.registerAgent('metrics-runtime-success', async context => {
      clockMs += context.payload.durationMs;
      return successOutput(context.payload);
    });
    dagAgentManager.registerAgent('metrics-runtime-failure', async context => {
      const dependency = context.dependencyResults[`success-${context.payload.sequence}`];
      assert.deepEqual(dependency?.output, successOutput(context.payload),
        'DAG_METRICS_ARTIFACT_HYDRATION');
      clockMs += context.payload.durationMs;
      throw new Error(EXPECTED_FAILURE);
    });
    // Omit metrics and artifactStore: exercise both defaults from the compiled task runner.
    const dependencies = {
      abortSignal: abortController.signal,
      runPrompt: async () => {
        providerAttempts += 1;
        throw new Error('DAG_METRICS_FIXTURE_PROVIDER_FORBIDDEN');
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} }
    };
    const parseJob = input => {
      const parsed = parseDagNodeJobInput(JSON.parse(JSON.stringify(buildDagNodeJobInput(input))));
      assert.equal(parsed.ok, true, 'DAG_METRICS_JOB_PARSE');
      return parsed.value;
    };
    const checkArtifact = async result => {
      assert.equal(typeof result.artifactRef, 'string', 'DAG_METRICS_ARTIFACT_MISSING');
      assert.deepEqual(await artifactStore.readArtifact(result.artifactRef), result.output,
        'DAG_METRICS_ARTIFACT_ROUND_TRIP');
      const file = containedPath(artifactRoot, result.artifactRef);
      artifacts.push({ file, bytes: await fs.readFile(file, 'utf8') });
    };

    let priorSnapshot;
    let priorExpected;
    for (let batch = 0; batch < BATCH_COUNT; batch += 1) {
      let latestSuccessDuration;
      let latestFailureDuration;
      let latestTokens;
      for (let pair = 0; pair < PAIRS_PER_BATCH; pair += 1) {
        assert.ok(performance.now() - startedAt < TIME_LIMIT_MS,
          'DAG_METRICS_FIXTURE_TIMEOUT');
        abortController.signal.throwIfAborted();
        const sequence = batch * PAIRS_PER_BATCH + pair;
        const lastJob = sequence === BATCH_COUNT * PAIRS_PER_BATCH - 1;
        latestSuccessDuration = lastJob ? 0 : sequence % 17;
        latestFailureDuration = lastJob ? 0 : sequence % 13;
        latestTokens = lastJob ? 0 : (sequence * 7) % 31;
        const common = {
          dagId: `dagrun_metrics_runtime_${sequence}`,
          depth: 0,
          attempt: sequence % 3,
          maxRetries: 0,
          waitingTimeoutMs: TIME_LIMIT_MS
        };
        const payload = { sequence, tokensUsed: latestTokens };
        const success = await runDagNodeJob(parseJob({
          ...common,
          node: { id: `success-${sequence}`, type: 'agent', dependencies: [],
            executionKey: 'metrics-runtime-success' },
          payload: { ...payload, durationMs: latestSuccessDuration }
        }), dependencies);
        assert.equal(success.status, 'success', 'DAG_METRICS_SUCCESS_RESULT');
        assert.deepEqual(success.output, successOutput(payload), 'DAG_METRICS_SUCCESS_OUTPUT');
        assert.equal(success.metrics?.durationMs, latestSuccessDuration,
          'DAG_METRICS_SUCCESS_DURATION');
        await checkArtifact(success);

        const failure = await runDagNodeJob(parseJob({
          ...common,
          node: { id: `failure-${sequence}`, type: 'agent', dependencies: [success.nodeId],
            executionKey: 'metrics-runtime-failure' },
          payload: { ...payload, durationMs: latestFailureDuration },
          dependencyResults: { [success.nodeId]: {
            ...success, output: createArtifactReferenceOutput(success.artifactRef)
          } }
        }), dependencies);
        assert.equal(failure.status, 'failed', 'DAG_METRICS_FAILURE_RESULT');
        assert.deepEqual(failure.output,
          { errorMessage: EXPECTED_FAILURE, durationMs: latestFailureDuration },
          'DAG_METRICS_FAILURE_OUTPUT');
        await checkArtifact(failure);
      }

      // Inspect retained state BEFORE snapshot(), catching cleanup-on-read implementations too.
      assert.equal(dagMetrics.durationsMs, storage, 'DAG_METRICS_STORAGE_REPLACED');
      assert.deepEqual([...storage.keys()].sort(), DURATION_KEYS,
        'DAG_METRICS_RETENTION_UNBOUNDED');
      assert.ok([...storage.values()].every(value => typeof value === 'number'),
        'DAG_METRICS_RETENTION_UNBOUNDED');
      assert.deepEqual(Object.fromEntries(storage), {
        node_execution: latestSuccessDuration,
        node_execution_failed: latestFailureDuration
      }, 'DAG_METRICS_RETAINED_VALUES');
      const completedPairs = (batch + 1) * PAIRS_PER_BATCH;
      const expected = {
        counters: { node_success: completedPairs, node_failure: completedPairs },
        gauges: { last_node_token_usage: latestTokens },
        durationsMs: { node_execution: [latestSuccessDuration],
          node_execution_failed: [latestFailureDuration] }
      };
      const snapshot = dagMetrics.snapshot();
      assert.deepEqual(snapshot, expected, 'DAG_METRICS_SNAPSHOT');
      if (priorSnapshot) {
        assert.deepEqual(priorSnapshot, priorExpected, 'DAG_METRICS_PRIOR_SNAPSHOT_MUTATED');
      }
      priorSnapshot = snapshot;
      priorExpected = structuredClone(expected);
      const detached = dagMetrics.snapshot();
      detached.counters.node_success = -1;
      detached.gauges.last_node_token_usage = -1;
      detached.durationsMs.node_execution.push(-1);
      assert.deepEqual(dagMetrics.snapshot(), expected, 'DAG_METRICS_SNAPSHOT_NOT_DETACHED');
      const expectedHealthValues = {
        'dag.counter.node_success': completedPairs,
        'dag.counter.node_failure': completedPairs,
        'dag.gauge.last_node_token_usage': latestTokens,
        'dag.duration.node_execution': latestSuccessDuration,
        'dag.duration.node_execution_failed': latestFailureDuration
      };
      const healthValues = Object.fromEntries(Object.entries(healthMetrics.getMetrics())
        .filter(([key]) => key.startsWith('dag.')).map(([key, entry]) => [key, entry.value]));
      assert.deepEqual(healthValues, expectedHealthValues, 'DAG_METRICS_HEALTH_VALUES');
      checkpoints.push({ completedPairs, retainedDurationScalars: storage.size });
    }

    for (const artifact of artifacts) {
      assert.equal(await fs.readFile(artifact.file, 'utf8'), artifact.bytes,
        'DAG_METRICS_ARTIFACT_CHANGED');
    }
    assert.equal(providerAttempts, 0, 'DAG_METRICS_FIXTURE_PROVIDER_FORBIDDEN');
    assert.equal(networkAttempts, 0, 'DAG_METRICS_FIXTURE_NETWORK_FORBIDDEN');
    proof = { status: 'PASS', fixture: 'dag-metrics-compiled-runtime-v1',
      jobs: BATCH_COUNT * PAIRS_PER_BATCH * 2, checkpoints,
      artifactsVerified: artifacts.length, artifactHydrations: BATCH_COUNT * PAIRS_PER_BATCH,
      finalDurationsMs: [0, 0], finalTokenGauge: 0,
      providerAttempts, networkAttempts };
  } finally {
    clearTimeout(deadline);
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
    if (originalArtifactDirectory === undefined) delete process.env.TRINITY_ARTIFACT_STORE_DIR;
    else process.env.TRINITY_ARTIFACT_STORE_DIR = originalArtifactDirectory;
    if (originalArtifactBackend === undefined) delete process.env.TRINITY_ARTIFACT_STORE_BACKEND;
    else process.env.TRINITY_ARTIFACT_STORE_BACKEND = originalArtifactBackend;
    if (temporaryRoot) {
      assert.equal(await fs.realpath(temporaryRoot), temporaryRoot,
        'DAG_METRICS_FIXTURE_CLEANUP_ROOT_CHANGED');
      assert.equal(path.dirname(temporaryRoot), temporaryParent,
        'DAG_METRICS_FIXTURE_CLEANUP_ROOT_ESCAPE');
      assert.ok(path.basename(temporaryRoot).startsWith('arcanos-dag-metrics-'),
        'DAG_METRICS_FIXTURE_CLEANUP_ROOT_ESCAPE');
      assert.equal((await fs.lstat(temporaryRoot)).isSymbolicLink(), false,
        'DAG_METRICS_FIXTURE_CLEANUP_ROOT_CHANGED');
      await fs.rm(temporaryRoot, { recursive: true });
      await assert.rejects(fs.access(temporaryRoot), { code: 'ENOENT' });
      cleaned = true;
    }
  }
  process.stdout.write(`${JSON.stringify({ ...proof, temporaryArtifactsRemoved: cleaned })}\n`);
}

try {
  await runFixture();
} catch (error) {
  // Keep failure diagnostics content-free, including negative-control assertion codes.
  const fixtureCode = typeof error?.message === 'string'
    ? error.message.match(/\bDAG_METRICS_[A-Z_]+\b/u)?.[0]
    : undefined;
  process.stderr.write(`${JSON.stringify({ status: 'FAIL',
    code: fixtureCode ?? error?.code ?? 'DAG_METRICS_RUNTIME_UNEXPECTED_ERROR',
    errorName: error?.name ?? 'Error' })}\n`);
  process.exitCode = 1;
}
