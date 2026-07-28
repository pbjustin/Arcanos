import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as nodeFs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  clearPromptDebugTracesForTest,
  extractPromptText,
  flushPromptDebugTracePersistenceForTest,
  getLatestPromptDebugTrace,
  listPromptDebugTraces,
  recordPromptDebugTrace,
  reloadPromptDebugTracesFromDiskForTest,
  shouldInspectRuntimePrompt,
  suppressPromptDebugTraceContent,
} = await import('../src/services/promptDebugTraceService.js');
const { classifyIntentMode } = await import('../src/shared/text/intentModeClassifier.js');

describe('promptDebugTraceService persistence', () => {
  let tempDir = '';
  let storagePath = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arcanos-prompt-debug-'));
    storagePath = path.join(tempDir, 'prompt-debug-events.jsonl');
    process.env.PROMPT_DEBUG_EVENTS_PATH = storagePath;
    process.env.PROMPT_DEBUG_TRACE_MODE = 'full';
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'true';
    process.env.PROMPT_DEBUG_TRACE_MAX_BYTES = '1048576';
    await clearPromptDebugTracesForTest();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.env.PROMPT_DEBUG_EVENTS_PATH = storagePath;
    await clearPromptDebugTracesForTest();
    delete process.env.PROMPT_DEBUG_EVENTS_PATH;
    delete process.env.PROMPT_DEBUG_TRACE_MODE;
    delete process.env.PROMPT_DEBUG_TRACE_PERSIST;
    delete process.env.PROMPT_DEBUG_TRACE_MAX_BYTES;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('persists incremental stage events and reconstructs traces from disk', async () => {
    const appendFileSpy = jest.spyOn(nodeFs.promises, 'appendFile').mockResolvedValue();
    recordPromptDebugTrace('req-incremental', 'ingress', {
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'verify runtime',
    });
    recordPromptDebugTrace('req-incremental', 'preprocess', {
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'verify runtime',
      normalizedPrompt: 'verify runtime',
    });
    recordPromptDebugTrace('req-incremental', 'response', {
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'verify runtime',
      normalizedPrompt: 'verify runtime',
      responseReturned: { ok: true },
    });

    await flushPromptDebugTracePersistenceForTest();

    const persistedLines = appendFileSpy.mock.calls
      .filter(([filePath]) => filePath === storagePath)
      .flatMap(([_filePath, chunk]) => String(chunk).split(/\r?\n/).filter(line => line.trim().length > 0))
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(persistedLines).toHaveLength(3);
    expect(persistedLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'prompt-debug-stage-event',
          requestId: 'req-incremental',
        }),
      ]),
    );
    expect(persistedLines.every(line => !Object.prototype.hasOwnProperty.call(line, 'stages'))).toBe(true);

    appendFileSpy.mockRestore();
    await fsp.writeFile(storagePath, `${persistedLines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    await reloadPromptDebugTracesFromDiskForTest();

    await expect(getLatestPromptDebugTrace('req-incremental')).resolves.toMatchObject({
      requestId: 'req-incremental',
      rawPrompt: 'verify runtime',
      normalizedPrompt: 'verify runtime',
      responseReturned: { ok: true },
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'ingress' }),
        expect.objectContaining({ stage: 'preprocess' }),
        expect.objectContaining({ stage: 'response' }),
      ]),
    });
  });

  it('records rapid trace updates without corrupting the append-only event log', async () => {
    const appendFileSpy = jest.spyOn(nodeFs.promises, 'appendFile').mockResolvedValue();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        Promise.resolve().then(() => {
          const requestId = `req-concurrent-${index}`;
          const prompt = `prompt-${index}`;
          recordPromptDebugTrace(requestId, 'ingress', {
            endpoint: '/gpt/arcanos-core',
            method: 'POST',
            rawPrompt: prompt,
          });
          recordPromptDebugTrace(requestId, 'response', {
            endpoint: '/gpt/arcanos-core',
            method: 'POST',
            rawPrompt: prompt,
            normalizedPrompt: prompt,
            responseReturned: { index },
          });
        }),
      ),
    );

    await flushPromptDebugTracePersistenceForTest();

    const persistedLines = appendFileSpy.mock.calls
      .filter(([filePath]) => filePath === storagePath)
      .flatMap(([_filePath, chunk]) => String(chunk).split(/\r?\n/).filter(line => line.trim().length > 0))
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(persistedLines).toHaveLength(50);
    expect(new Set(persistedLines.map(line => line.requestId)).size).toBe(25);
    appendFileSpy.mockRestore();

    await expect(getLatestPromptDebugTrace('req-concurrent-17')).resolves.toMatchObject({
      requestId: 'req-concurrent-17',
      responseReturned: { index: 17 },
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'ingress' }),
        expect.objectContaining({ stage: 'response' }),
      ]),
    });
  });

  it('fails gracefully when trace persistence cannot write to disk', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const appendFileSpy = jest.spyOn(nodeFs.promises, 'appendFile').mockRejectedValue(new Error('append failed'));

    recordPromptDebugTrace('req-persist-failure', 'ingress', {
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'runtime check',
    });

    await expect(flushPromptDebugTracePersistenceForTest()).resolves.toBeUndefined();
    await expect(getLatestPromptDebugTrace('req-persist-failure')).resolves.toMatchObject({
      requestId: 'req-persist-failure',
      rawPrompt: 'runtime check',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();

    appendFileSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('discards failed buffered events when persistence is disabled before re-enablement', async () => {
    const appendFileSpy = jest
      .spyOn(nodeFs.promises, 'appendFile')
      .mockRejectedValueOnce(new Error('append failed'))
      .mockResolvedValue(undefined);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    recordPromptDebugTrace('req-before-disable', 'ingress', {
      rawPrompt: 'pre-disable-private-marker',
    });
    await flushPromptDebugTracePersistenceForTest();

    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    await listPromptDebugTraces();
    const callsBeforeReenable = appendFileSpy.mock.calls.length;

    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'true';
    recordPromptDebugTrace('req-after-reenable', 'ingress', {
      rawPrompt: 'post-reenable-marker',
    });
    await flushPromptDebugTracePersistenceForTest();

    const postReenableWrites = appendFileSpy.mock.calls
      .slice(callsBeforeReenable)
      .map(([_filePath, chunk]) => String(chunk))
      .join('');
    expect(postReenableWrites).toContain('post-reenable-marker');
    expect(postReenableWrites).not.toContain('pre-disable-private-marker');

    appendFileSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('revokes an in-flight persistence entry across a disable and re-enable cycle', async () => {
    const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
    let releaseStat: (() => void) | undefined;
    let reportStatStarted: (() => void) | undefined;
    const statGate = new Promise<void>(resolve => {
      releaseStat = resolve;
    });
    const statStarted = new Promise<void>(resolve => {
      reportStatStarted = resolve;
    });
    let shouldDelay = true;
    const statSpy = jest.spyOn(nodeFs.promises, 'stat');
    statSpy.mockImplementation((async (...args: Parameters<typeof nodeFs.promises.stat>) => {
      if (shouldDelay && String(args[0]) === storagePath) {
        shouldDelay = false;
        reportStatStarted?.();
        await statGate;
      }
      return originalStat(...args);
    }) as typeof nodeFs.promises.stat);

    recordPromptDebugTrace('req-in-flight-before-disable', 'ingress', {
      rawPrompt: 'revoked-in-flight-private-marker',
    });
    await statStarted;

    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    await listPromptDebugTraces();
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'true';
    recordPromptDebugTrace('req-in-flight-after-reenable', 'ingress', {
      rawPrompt: 'current-after-reenable-marker',
    });

    releaseStat?.();
    await flushPromptDebugTracePersistenceForTest();

    const persisted = await fsp.readFile(storagePath, 'utf8');
    expect(persisted).toContain('current-after-reenable-marker');
    expect(persisted).not.toContain('revoked-in-flight-private-marker');
    statSpy.mockRestore();
  });

  it('rolls back an append that becomes stale while the write is in flight', async () => {
    await fsp.writeFile(storagePath, '', 'utf8');
    const originalAppendFile = nodeFs.promises.appendFile.bind(
      nodeFs.promises,
    );
    let releaseAppend: (() => void) | undefined;
    let reportAppendStarted: (() => void) | undefined;
    const appendGate = new Promise<void>(resolve => {
      releaseAppend = resolve;
    });
    const appendStarted = new Promise<void>(resolve => {
      reportAppendStarted = resolve;
    });
    let shouldDelay = true;
    const appendFileSpy = jest.spyOn(nodeFs.promises, 'appendFile');
    appendFileSpy.mockImplementation(
      (async (...args: Parameters<typeof nodeFs.promises.appendFile>) => {
        if (shouldDelay && String(args[0]) === storagePath) {
          shouldDelay = false;
          reportAppendStarted?.();
          await appendGate;
        }
        return originalAppendFile(...args);
      }) as typeof nodeFs.promises.appendFile,
    );

    recordPromptDebugTrace('req-writing-before-disable', 'ingress', {
      rawPrompt: 'stale-write-private-marker',
    });
    await appendStarted;

    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    await listPromptDebugTraces();
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'true';
    recordPromptDebugTrace('req-writing-after-reenable', 'ingress', {
      rawPrompt: 'current-write-marker',
    });

    releaseAppend?.();
    await flushPromptDebugTracePersistenceForTest();

    const persisted = await fsp.readFile(storagePath, 'utf8');
    expect(persisted).toContain('current-write-marker');
    expect(persisted).not.toContain('stale-write-private-marker');
    appendFileSpy.mockRestore();
  });

  it('records delegated prompt-generation intent reasons in trace tags', async () => {
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    recordPromptDebugTrace('req-delegated-intent', 'ingress', {
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'Give me something I can hand to Codex to fix this',
    });

    await expect(getLatestPromptDebugTrace('req-delegated-intent')).resolves.toMatchObject({
      contentMode: 'metadata',
      requestId: 'req-delegated-intent',
      rawPrompt: '',
      normalizedPrompt: '',
      intentTags: expect.arrayContaining([
        'prompt_authoring_requested',
        'intent_mode_prompt_generation',
        'intent_reason_delegated_deliverable_for_downstream_executor',
      ]),
    });
  });

  it('uses precomputed intent classification when suppressing runtime-inspection tags for prompt generation', () => {
    const prompt = 'Write a prompt for Codex to verify runtime status.';

    expect(shouldInspectRuntimePrompt(prompt, classifyIntentMode(prompt))).toBe(false);
    expect(shouldInspectRuntimePrompt('Verify runtime status.')).toBe(true);
  });

  it('defaults to metadata-only memory traces without retaining content', async () => {
    delete process.env.PROMPT_DEBUG_TRACE_MODE;
    delete process.env.PROMPT_DEBUG_TRACE_PERSIST;
    delete process.env.PROMPT_DEBUG_TRACE_MAX_BYTES;

    recordPromptDebugTrace('req-metadata-default', 'response', {
      traceId: 'trace-metadata-default',
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'verify runtime with sk-test-secret-value-1234567890',
      normalizedPrompt: 'verify runtime with a secret',
      selectedRoute: '/gpt/arcanos-core',
      selectedModule: 'ARCANOS:CORE',
      selectedTools: ['self-heal-runtime'],
      runtimeInspectionChosen: true,
      finalExecutorPayload: {
        sessionId: 'session-sensitive',
        overrideAuditSafe: true,
      },
      responseReturned: {
        output: 'private model response',
      },
      fallbackPathUsed: 'error-handler',
      fallbackReason: 'Bearer test-sensitive-runtime-token-123456789',
    });

    const trace = await getLatestPromptDebugTrace('req-metadata-default');
    expect(trace).toMatchObject({
      contentMode: 'metadata',
      requestId: 'req-metadata-default',
      traceId: 'trace-metadata-default',
      rawPrompt: '',
      normalizedPrompt: '',
      finalExecutorPayload: null,
      responseReturned: null,
      fallbackPathUsed: 'error-handler',
      fallbackReason: null,
      runtimeInspectionChosen: true,
      intentTags: expect.arrayContaining(['runtime_inspection_candidate']),
    });
    expect(trace?.stages).toHaveLength(1);
    expect(trace?.stages[0]?.data).not.toHaveProperty('rawPrompt');
    expect(trace?.stages[0]?.data).not.toHaveProperty('normalizedPrompt');
    expect(trace?.stages[0]?.data).not.toHaveProperty('finalExecutorPayload');
    expect(trace?.stages[0]?.data).not.toHaveProperty('responseReturned');

    await flushPromptDebugTracePersistenceForTest();
    await expect(fsp.stat(storagePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('treats invalid modes as off and does not hydrate existing raw traces', async () => {
    const rawPersistedLine = JSON.stringify({
      kind: 'prompt-debug-stage-event',
      requestId: 'req-raw-on-disk',
      stage: 'ingress',
      timestamp: '2026-07-25T12:00:00.000Z',
      patch: {
        rawPrompt: 'historical private prompt',
      },
    });
    await fsp.writeFile(storagePath, `${rawPersistedLine}\n`, 'utf8');
    process.env.PROMPT_DEBUG_TRACE_MODE = 'unexpected';

    await reloadPromptDebugTracesFromDiskForTest();
    await expect(listPromptDebugTraces()).resolves.toEqual([]);
    expect(
      recordPromptDebugTrace('req-off', 'ingress', {
        rawPrompt: 'must not be retained',
      }),
    ).toMatchObject({
      contentMode: 'off',
      rawPrompt: '',
      stages: [],
    });
    await flushPromptDebugTracePersistenceForTest();
    await expect(fsp.readFile(storagePath, 'utf8')).resolves.toBe(
      `${rawPersistedLine}\n`,
    );
  });

  it('does not return raw disk content when mode changes to metadata during hydration', async () => {
    await fsp.writeFile(
      storagePath,
      `${JSON.stringify({
        kind: 'prompt-debug-stage-event',
        contentMode: 'full',
        requestId: 'req-hydration-downgrade',
        stage: 'ingress',
        timestamp: '2026-07-25T12:00:00.000Z',
        patch: {
          endpoint: '/gpt/arcanos-core',
          rawPrompt: 'in-flight-private-marker',
        },
      })}\n`,
      'utf8',
    );

    const pendingList = listPromptDebugTraces();
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';

    await expect(pendingList).resolves.toEqual([
      expect.objectContaining({
        contentMode: 'metadata',
        requestId: 'req-hydration-downgrade',
        rawPrompt: '',
      }),
    ]);
  });

  it('returns no disk content when mode changes to off during hydration', async () => {
    await fsp.writeFile(
      storagePath,
      `${JSON.stringify({
        kind: 'prompt-debug-stage-event',
        contentMode: 'full',
        requestId: 'req-hydration-off',
        stage: 'ingress',
        timestamp: '2026-07-25T12:00:00.000Z',
        patch: {
          rawPrompt: 'in-flight-off-private-marker',
        },
      })}\n`,
      'utf8',
    );

    const pendingList = listPromptDebugTraces();
    process.env.PROMPT_DEBUG_TRACE_MODE = 'off';

    await expect(pendingList).resolves.toEqual([]);
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    await expect(listPromptDebugTraces()).resolves.toEqual([]);
  });

  it('logs one fixed diagnostic for malformed persisted lines without copying their content', async () => {
    const privateMarker = 'historical-private-prompt-marker';
    await fsp.writeFile(
      storagePath,
      [
        `{"rawPrompt":"${privateMarker}",BROKEN`,
        `{"rawPrompt":"${privateMarker}-second",BROKEN`,
        '',
      ].join('\n'),
      'utf8',
    );
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await reloadPromptDebugTracesFromDiskForTest();

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[prompt-debug] skipped malformed persisted trace lines',
    );
    const loggedArguments = [
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ]
      .flat()
      .map(value => String(value))
      .join(' ');
    expect(loggedArguments).not.toContain(privateMarker);
  });

  it('skips oversized persisted lines while hydrating later bounded events', async () => {
    const validEvent = JSON.stringify({
      kind: 'prompt-debug-stage-event',
      contentMode: 'metadata',
      requestId: 'req-after-oversized-line',
      stage: 'routing',
      timestamp: '2026-07-25T12:00:00.000Z',
      patch: {
        selectedRoute: '/gpt/:gptId',
      },
    });
    await fsp.writeFile(
      storagePath,
      `${'x'.repeat(64 * 1024 + 1)}\n${validEvent}\n`,
      'utf8',
    );
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    await reloadPromptDebugTracesFromDiskForTest();

    await expect(
      getLatestPromptDebugTrace('req-after-oversized-line'),
    ).resolves.toMatchObject({
      contentMode: 'metadata',
      selectedRoute: '/gpt/:gptId',
    });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[prompt-debug] skipped persisted trace lines exceeding the per-event byte limit',
    );
  });

  it('stops hydration when storage grows beyond the configured total byte limit', async () => {
    const initialEvent = JSON.stringify({
      kind: 'prompt-debug-stage-event',
      contentMode: 'metadata',
      requestId: 'req-growing-storage',
      stage: 'routing',
      timestamp: '2026-07-25T12:00:00.000Z',
      patch: {
        selectedRoute: '/gpt/:gptId',
      },
    });
    await fsp.writeFile(storagePath, `${initialEvent}\n`, 'utf8');
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    process.env.PROMPT_DEBUG_TRACE_MAX_BYTES = '1024';

    const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
    let shouldGrow = true;
    const statSpy = jest.spyOn(nodeFs.promises, 'stat');
    statSpy.mockImplementation((async (...args: Parameters<typeof nodeFs.promises.stat>) => {
      const result = await originalStat(...args);
      if (shouldGrow && String(args[0]) === storagePath) {
        shouldGrow = false;
        await fsp.appendFile(
          storagePath,
          `${'x'.repeat(2048)}\n`,
          'utf8',
        );
      }
      return result;
    }) as typeof nodeFs.promises.stat);
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    await reloadPromptDebugTracesFromDiskForTest();

    await expect(
      getLatestPromptDebugTrace('req-growing-storage'),
    ).resolves.toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[prompt-debug] trace storage exceeded the configured byte limit during hydration; hydration skipped',
    );
    statSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('does not duplicate hydrated stages across content-mode toggles', async () => {
    const events = ['ingress', 'routing'].map((stage, index) =>
      JSON.stringify({
        kind: 'prompt-debug-stage-event',
        contentMode: 'full',
        requestId: 'req-mode-toggle',
        stage,
        timestamp: `2026-07-25T12:00:0${index}.000Z`,
        patch: {
          rawPrompt: 'mode-toggle-private-marker',
          selectedRoute: '/gpt/:gptId',
        },
      }),
    );
    await fsp.writeFile(storagePath, `${events.join('\n')}\n`, 'utf8');

    await reloadPromptDebugTracesFromDiskForTest();
    expect(
      (await getLatestPromptDebugTrace('req-mode-toggle'))?.stages,
    ).toHaveLength(2);

    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    const metadataTrace = await getLatestPromptDebugTrace('req-mode-toggle');
    expect(metadataTrace?.rawPrompt).toBe('');
    expect(metadataTrace?.stages).toHaveLength(2);

    process.env.PROMPT_DEBUG_TRACE_MODE = 'full';
    expect(
      (await getLatestPromptDebugTrace('req-mode-toggle'))?.stages,
    ).toHaveLength(2);
  });

  it('redacts bounded full-mode content before storing it', async () => {
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    recordPromptDebugTrace('req-full-redaction', 'response', {
      rawPrompt: 'use sk-test-secret-value-1234567890',
      normalizedPrompt: 'use sk-test-secret-value-1234567890',
      finalExecutorPayload: {
        sessionId: 'private-session',
        action: 'inspect',
      },
      responseReturned: {
        authorization: 'Bearer test-sensitive-runtime-token-123456789',
        ok: true,
      },
      fallbackReason: 'Bearer test-sensitive-runtime-token-123456789',
    });

    await expect(getLatestPromptDebugTrace('req-full-redaction')).resolves.toMatchObject({
      contentMode: 'full',
      rawPrompt: '[REDACTED]',
      normalizedPrompt: '[REDACTED]',
      finalExecutorPayload: {
        sessionId: '[REDACTED]',
        action: 'inspect',
      },
      responseReturned: {
        authorization: '[REDACTED]',
        ok: true,
      },
      fallbackReason: '[REDACTED]',
    });
  });

  it('redacts opaque credentials under separator-varied sensitive keys', async () => {
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    recordPromptDebugTrace('req-key-redaction', 'executor', {
      finalExecutorPayload: {
        'x-api-key': 'opaque-value-one',
        'private-key': 'opaque-value-two',
        'database-url': 'opaque-value-three',
        nested: {
          'redis.url': 'opaque-value-four',
        },
      },
    });

    await expect(
      getLatestPromptDebugTrace('req-key-redaction'),
    ).resolves.toMatchObject({
      finalExecutorPayload: {
        'x-api-key': '[REDACTED]',
        'private-key': '[REDACTED]',
        'database-url': '[REDACTED]',
        nested: {
          'redis.url': '[REDACTED]',
        },
      },
    });
  });

  it('bounds recursive prompt extraction and handles cyclic executor payloads', () => {
    const cyclicPayload: Record<string, unknown> = {};
    cyclicPayload.payload = cyclicPayload;
    expect(extractPromptText(cyclicPayload)).toBeNull();

    let deeplyNestedPayload: Record<string, unknown> = {
      prompt: 'unreachable-deep-prompt',
    };
    for (let depth = 0; depth < 20; depth += 1) {
      deeplyNestedPayload = { payload: deeplyNestedPayload };
    }
    expect(extractPromptText(deeplyNestedPayload)).toBeNull();
    expect(() =>
      recordPromptDebugTrace('req-cyclic-payload', 'executor', {
        rawPrompt: 'verify runtime',
        finalExecutorPayload: cyclicPayload,
      }),
    ).not.toThrow();
  });

  it('preserves the bounded trace contract and requested list size', async () => {
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    for (let index = 0; index < 15; index += 1) {
      recordPromptDebugTrace(`req-list-${index}`, 'routing', {
        selectedRoute: '/gpt/:gptId',
        fallbackPathUsed: 'none',
      });
    }

    const traces = await listPromptDebugTraces(15);
    expect(traces).toHaveLength(15);
    expect(traces[0]).toEqual(
      expect.objectContaining({
        contentMode: 'metadata',
        fallbackPathUsed: 'none',
        fallbackReason: null,
        preservedConstraints: expect.any(Array),
        droppedConstraints: expect.any(Array),
        stages: [
          expect.objectContaining({
            stage: 'routing',
            data: expect.any(Object),
          }),
        ],
      }),
    );
  });

  it('suppresses GPT Access response and failure content even in full mode', async () => {
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';
    const suppressed = suppressPromptDebugTraceContent({
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'private delegated task',
      normalizedPrompt: 'private delegated task',
      selectedRoute: '/gpt/arcanos-core',
      selectedModule: 'ARCANOS:CORE',
      finalExecutorPayload: {
        prompt: 'private delegated task',
      },
      responseReturned: {
        output: 'private generated response',
      },
      fallbackPathUsed: 'error-handler',
      fallbackReason: 'private provider failure detail',
    });
    recordPromptDebugTrace('req-gpt-access-suppressed', 'response', suppressed);

    await expect(
      getLatestPromptDebugTrace('req-gpt-access-suppressed'),
    ).resolves.toMatchObject({
      contentMode: 'full',
      rawPrompt: '[REDACTED_GPT_ACCESS_PROMPT]',
      normalizedPrompt: '[REDACTED_GPT_ACCESS_PROMPT]',
      finalExecutorPayload: null,
      responseReturned: null,
      fallbackPathUsed: 'error-handler',
      fallbackReason: null,
    });
  });

  it('stops appending complete events at the configured byte cap', async () => {
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    process.env.PROMPT_DEBUG_TRACE_MAX_BYTES = '1024';
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    for (let index = 0; index < 20; index += 1) {
      recordPromptDebugTrace(`req-byte-cap-${index}`, 'routing', {
        endpoint: '/gpt/arcanos-core',
        method: 'POST',
        selectedRoute: '/gpt/arcanos-core',
        selectedModule: 'ARCANOS:CORE',
      });
    }
    await flushPromptDebugTracePersistenceForTest();

    const persisted = await fsp.readFile(storagePath, 'utf8');
    expect(Buffer.byteLength(persisted, 'utf8')).toBeLessThanOrEqual(1024);
    expect(persisted.endsWith('\n')).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[prompt-debug] persistence byte limit reached; dropping new trace events',
    );
    consoleWarnSpy.mockRestore();
  });
});
