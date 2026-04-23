import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as nodeFs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  clearPromptDebugTracesForTest,
  flushPromptDebugTracePersistenceForTest,
  getLatestPromptDebugTrace,
  recordPromptDebugTrace,
  reloadPromptDebugTracesFromDiskForTest,
} = await import('../src/services/promptDebugTraceService.js');

describe('promptDebugTraceService persistence', () => {
  let tempDir = '';
  let storagePath = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arcanos-prompt-debug-'));
    storagePath = path.join(tempDir, 'prompt-debug-events.jsonl');
    process.env.PROMPT_DEBUG_EVENTS_PATH = storagePath;
    await clearPromptDebugTracesForTest();
  });

  afterEach(async () => {
    process.env.PROMPT_DEBUG_EVENTS_PATH = storagePath;
    await clearPromptDebugTracesForTest();
    delete process.env.PROMPT_DEBUG_EVENTS_PATH;
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

  it('records delegated prompt-generation intent reasons in trace tags', async () => {
    recordPromptDebugTrace('req-delegated-intent', 'ingress', {
      endpoint: '/gpt/arcanos-core',
      method: 'POST',
      rawPrompt: 'Give me something I can hand to Codex to fix this',
    });

    await expect(getLatestPromptDebugTrace('req-delegated-intent')).resolves.toMatchObject({
      requestId: 'req-delegated-intent',
      intentTags: expect.arrayContaining([
        'prompt_authoring_requested',
        'intent_mode_prompt_generation',
        'intent_reason_delegated_deliverable_for_downstream_executor',
      ]),
    });
  });
});
