import { describe, expect, it } from '@jest/globals';

import { parseDagNodeJobInput } from '../src/jobs/jobSchema.js';
import { JobDataSchema, MemoryEntrySchema } from '../src/core/db/schema.js';
import { INTEGRITY_MANIFEST } from '../src/platform/runtime/integrityManifest.js';
import {
  assertIntegrityPayloadSchema,
  computeIntegrityHash,
  IntegrityPayloadSchemaError,
} from '../src/platform/runtime/integrityDigest.js';
import {
  AgentCommandStepExecutionResultSchema,
  AgentExecutionTraceEventSchema,
} from '../src/services/agentExecutionSchemas.js';
import { controlPlaneInvokeRequestSchema } from '../src/services/controlPlane/schema.js';
import { NormalizedGamingBuildSchema } from '../src/services/gamingBuildResourceSchema.js';
import {
  inboxListInputSchema,
  knowledgeFindInputSchema,
  projectListInputSchema,
  taskCreateInputSchema,
  taskListInputSchema,
} from '../src/services/productivity/productivitySchemas.js';
import { AiOutputBoundaryError, parseToolArgumentsWithSchema } from '../src/services/safety/aiOutputBoundary.js';
import { SessionApiReplayResponseSchema } from '../src/services/sessionApiSchemas.js';

describe('Zod service contract compatibility', () => {
  it.each([
    ['inbox', inboxListInputSchema],
    ['tasks', taskListInputSchema],
    ['projects', projectListInputSchema],
    ['knowledge', knowledgeFindInputSchema],
  ])('preserves an omitted %s limit rather than applying an inner default', (_name, schema) => {
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ limit: 1 })).toEqual({ limit: 1 });
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('keeps applied defaults, trimming, and strict productivity fields', () => {
    expect(taskCreateInputSchema.parse({ title: '  Review contracts  ' })).toEqual({
      title: 'Review contracts',
      status: 'next',
      priority: 0,
    });
    expect(taskCreateInputSchema.safeParse({ title: 'Review', ownerPrincipalId: 'caller' }).success).toBe(false);
  });

  it('keeps UTF-16 string limits for supplementary Unicode characters', () => {
    expect(taskCreateInputSchema.safeParse({ title: '😀'.repeat(120) }).success).toBe(true);
    expect(taskCreateInputSchema.safeParse({ title: '😀'.repeat(121) }).success).toBe(false);
    const source = { url: 'https://example.test/build', resourceType: 'build_planner', extractor: 'test', confidence: 0.9 };
    expect(NormalizedGamingBuildSchema.safeParse({ title: '😀'.repeat(2_048), source }).success).toBe(true);
    expect(NormalizedGamingBuildSchema.safeParse({ title: '😀'.repeat(2_049), source }).success).toBe(false);
  });

  it('keeps shape-valid legacy UUIDs and minute-precision timestamps', () => {
    const projectId = '11111111-1111-1111-1111-111111111111';
    const parsed = taskCreateInputSchema.parse({
      title: 'Review', projectId, dueAt: '2026-10-23T12:34+0000',
    });
    expect(parsed.projectId).toBe(projectId);
    expect(parsed.dueAt).toBe('2026-10-23T12:34+0000');
    expect(taskCreateInputSchema.safeParse({ title: 'Review', projectId: 'malformed' }).success).toBe(false);
    expect(taskCreateInputSchema.safeParse({ title: 'Review', dueAt: '2026-02-30T12:34Z' }).success).toBe(false);
  });

  it('parses DAG maps and scheduler defaults while retaining arbitrary nested JSON', () => {
    const parsed = parseDagNodeJobInput({
      dagId: 'dag-1',
      node: { id: 'node-1', type: 'task', executionKey: 'test.task' },
      payload: { key: ['a', { nested: null }] },
      depth: 0,
    });

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        node: { dependencies: [] },
        payload: { key: ['a', { nested: null }] },
        dependencyResults: {},
        sharedState: {},
        attempt: 0,
        maxRetries: 2,
      },
    });
    expect(parseDagNodeJobInput({ dagId: 'dag-1', node: {}, payload: [], depth: 0 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('payload'),
    });
  });

  it('accepts legacy sparse arbitrary-value fields without dropping required scheduling fields', () => {
    const timestamp = new Date('2026-10-23T12:00:00.000Z');
    expect(MemoryEntrySchema.parse({ id: 1, key: 'legacy', created_at: timestamp, updated_at: timestamp }))
      .not.toHaveProperty('value');
    const job = {
      id: 'job-1', worker_id: 'worker-1', job_type: 'test', status: 'pending',
      claim_generation: '0', created_at: timestamp, updated_at: timestamp,
    };
    expect(JobDataSchema.parse(job)).not.toHaveProperty('input');
    expect(JobDataSchema.safeParse({ ...job, claim_generation: undefined }).success).toBe(false);
    const parsed = parseDagNodeJobInput({
      dagId: 'dag-1', node: { id: 'node-1', type: 'task', executionKey: 'test.task' }, depth: 0,
      dependencyResults: { prior: { nodeId: 'prior', status: 'success' } },
    });
    expect(parsed).toMatchObject({ ok: true, value: { dependencyResults: { prior: { nodeId: 'prior', status: 'success' } } } });
  });

  it('accepts legacy sparse response payloads while retaining required response metadata', () => {
    const timestamp = '2026-10-23T12:00:00.000Z';
    const replay = {
      sessionId: '11111111-1111-4111-8111-111111111111', replayedVersion: 1,
      mode: 'readonly', auditTraceId: null, replayedAt: timestamp,
    };
    expect(SessionApiReplayResponseSchema.parse(replay)).toEqual(replay);
    expect(SessionApiReplayResponseSchema.safeParse({ ...replay, replayedAt: undefined }).success).toBe(false);
    const step = {
      stepId: 'step-1', capabilityId: 'cap-1', commandName: 'test', status: 'completed', success: true,
      message: 'Done', commandMetadata: null, startedAt: timestamp, completedAt: timestamp, error: null,
    };
    expect(AgentCommandStepExecutionResultSchema.parse(step)).toEqual(step);
  });

  it('validates protected string records without changing the original hash payload', () => {
    const payload = { custom: { route: 'custom', module: 'CUSTOM', extra: 'retain-in-hash' } };
    const originalHash = computeIntegrityHash(payload);
    assertIntegrityPayloadSchema(INTEGRITY_MANIFEST.gpt_router_config.schema, payload);
    expect(computeIntegrityHash(payload)).toBe(originalHash);
    expect(payload.custom.extra).toBe('retain-in-hash');
    expect(() => assertIntegrityPayloadSchema(INTEGRITY_MANIFEST.daemon_tokens.schema, { daemon: '' }))
      .toThrow(IntegrityPayloadSchemaError);
    expect(() => assertIntegrityPayloadSchema(INTEGRITY_MANIFEST.fallback_messages.schema, { message: 42 }))
      .toThrow(IntegrityPayloadSchemaError);
  });

  it('keeps trace metadata as an arbitrary string-key record and rejects missing metadata', () => {
    const event = {
      timestamp: '2026-10-23T12:00:00.000Z',
      level: 'info',
      message: 'Completed',
      metadata: { nested: { enabled: true }, list: [1, null] },
    };
    expect(AgentExecutionTraceEventSchema.parse(event)).toEqual(event);
    expect(AgentExecutionTraceEventSchema.safeParse({ ...event, metadata: undefined }).success).toBe(false);
  });

  it('keeps control-plane params and default dry-run without weakening target validation', () => {
    const request = {
      operation: 'inspect',
      provider: 'arcanos-mcp',
      target: { resource: 'worker', generation: 1 },
      environment: 'workspace',
      scope: 'read',
      params: { filters: ['healthy'], nested: { value: null } },
      traceId: 'trace-1',
      requestedBy: 'operator',
    };
    expect(controlPlaneInvokeRequestSchema.parse(request)).toEqual({ ...request, dryRun: true });
    expect(controlPlaneInvokeRequestSchema.safeParse({ ...request, target: { resource: 'worker', unsafe: {} } }).success)
      .toBe(false);
  });

  it('preserves mixed Gaming stats and all numeric and strict source bounds', () => {
    const build = {
      stats: { power: 12, descriptor: 'bounded' },
      source: { url: 'https://example.test/build', resourceType: 'build_planner', extractor: 'test', confidence: 0.9 },
    };
    expect(NormalizedGamingBuildSchema.parse(build)).toEqual(build);
    expect(NormalizedGamingBuildSchema.safeParse({ ...build, stats: { power: Infinity } }).success).toBe(false);
    expect(NormalizedGamingBuildSchema.safeParse({ ...build, stats: { power: {} } }).success).toBe(false);
    expect(NormalizedGamingBuildSchema.safeParse({ ...build, source: { ...build.source, authority: true } }).success)
      .toBe(false);
  });

  it('preserves public AI output boundary messages for schema violations', () => {
    expect(() => parseToolArgumentsWithSchema('{}', taskCreateInputSchema, 'compatibility-test'))
      .toThrow('AI output failed schema validation: Required');
    expect(() => parseToolArgumentsWithSchema('{"title":false}', taskCreateInputSchema, 'compatibility-test'))
      .toThrow(AiOutputBoundaryError);
  });
});
