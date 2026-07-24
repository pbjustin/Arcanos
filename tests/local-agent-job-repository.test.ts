import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { PoolClient } from 'pg';

const recordJobEventMock = jest.fn(async () => ({ inserted: true as const }));
const recordJobEventWithClientMock = jest.fn(async () => undefined);
const dbLoggerWarnMock = jest.fn();

interface MutableJob {
  id: string;
  worker_id: string;
  job_type: string;
  status: string;
  input: Record<string, unknown>;
  output?: unknown;
  error_message?: string | null;
  retry_count: number;
  max_retries: number;
  next_run_at: Date;
  started_at?: Date | null;
  last_heartbeat_at?: Date | null;
  lease_expires_at?: Date | null;
  priority: number;
  last_worker_id?: string | null;
  correlation_id: string;
  autonomy_state: Record<string, unknown>;
  request_fingerprint_hash: string;
  idempotency_key_hash: string;
  idempotency_scope_hash: string;
  idempotency_origin: string;
  idempotency_until: Date;
  retention_until: Date;
  expires_at: Date;
  cancel_requested_at?: Date | null;
  cancel_reason?: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date | null;
}

const job = (): MutableJob => ({
  id: '10000000-0000-4000-8000-000000000001',
  worker_id: '20000000-0000-4000-8000-000000000001',
  job_type: 'local-agent',
  status: 'pending',
  input: {
    protocolVersion: 'local-agent-job-v1',
    requestPath: '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run',
    executionModeReason: 'gpt_access_local_agent_capability',
    job: {
      action: 'git.status',
      payload: {},
      principal: 'operator:primary',
      workspace: 'personal',
      deviceId: '20000000-0000-4000-8000-000000000001',
      traceId: 'trace:test',
      requestId: 'request:test',
      idempotencyKey: 'request:test:git.status',
      authorization: {
        decision: 'allow',
        evidenceId: 'evidence:test',
        evaluatedAt: '2026-07-24T12:00:00.000Z'
      },
      expiresAt: '2026-07-24T13:00:00.000Z',
      timeoutMs: 15_000,
      requiredDeviceScopes: ['git.status'],
      readOnly: true,
      mayModifyFiles: false
    }
  },
  retry_count: 0,
  max_retries: 0,
  next_run_at: new Date('2026-07-24T12:00:00.000Z'),
  priority: 100,
  last_worker_id: null,
  correlation_id: 'trace:test',
  autonomy_state: { localAgent: {} },
  request_fingerprint_hash: 'fingerprint',
  idempotency_key_hash: 'key-hash',
  idempotency_scope_hash: 'scope-hash',
  idempotency_origin: 'derived',
  idempotency_until: new Date('2026-07-25T12:00:00.000Z'),
  retention_until: new Date('2026-07-25T12:00:00.000Z'),
  expires_at: new Date('2099-07-24T13:00:00.000Z'),
  created_at: new Date('2026-07-24T12:00:00.000Z'),
  updated_at: new Date('2026-07-24T12:00:00.000Z'),
  completed_at: null
});

let storedJob: MutableJob;
let storedBinding: Record<string, unknown> | null;

function rows(value: unknown[] = []) {
  return { rows: value, rowCount: value.length };
}

const client = {
  query: jest.fn(async (rawSql: string, values: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/gu, ' ').trim();
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return rows();
    }
    if (
      sql.startsWith('SELECT * FROM job_data')
      && sql.includes("status IN ('pending', 'running')")
      && sql.includes('ORDER BY COALESCE(expires_at, lease_expires_at)')
      && sql.includes('FOR UPDATE SKIP LOCKED')
    ) {
      const hasExpired =
        ['pending', 'running'].includes(storedJob.status)
        && (
          storedJob.expires_at.getTime() <= Date.now()
          || (
            storedJob.status === 'running'
            && Boolean(storedJob.lease_expires_at)
            && storedJob.lease_expires_at!.getTime() < Date.now()
          )
        );
      return hasExpired ? rows([storedJob]) : rows();
    }
    if (
      sql.startsWith('WITH candidates AS')
      && sql.includes('DELETE FROM local_agent_job_idempotency')
    ) {
      return rows();
    }
    if (sql.startsWith('INSERT INTO local_agent_job_idempotency')) {
      if (storedBinding) {
        return rows();
      }
      storedBinding = {
        id: '30000000-0000-4000-8000-000000000001',
        principal_id: values[0],
        workspace_id: values[1],
        device_id: values[2],
        action: values[3],
        idempotency_key_hash: values[4],
        idempotency_scope_hash: values[5],
        request_fingerprint_hash: values[6],
        idempotency_origin: values[7],
        job_id: values[8],
        idempotency_until: values[9],
        created_at: new Date(),
        updated_at: new Date()
      };
      return rows([storedBinding]);
    }
    if (
      sql.startsWith('INSERT INTO job_data')
      && sql.includes('RETURNING *')
    ) {
      const envelope = JSON.parse(String(values[3])) as MutableJob['input'];
      storedJob = {
        ...job(),
        id: String(values[0]),
        worker_id: String(values[1]),
        input: envelope,
        correlation_id: String(values[4]),
        autonomy_state: JSON.parse(String(values[5])) as Record<string, unknown>,
        request_fingerprint_hash: String(values[6]),
        idempotency_key_hash: String(values[7]),
        idempotency_scope_hash: String(values[8]),
        idempotency_origin: String(values[9]),
        idempotency_until: new Date(String(values[10])),
        retention_until: new Date(String(values[11])),
        expires_at: new Date(String(values[12]))
      };
      return rows([storedJob]);
    }
    if (
      sql.startsWith('SELECT binding.*')
      && sql.includes('FROM local_agent_job_idempotency AS binding')
    ) {
      return storedBinding
        ? rows([{
          ...storedBinding,
          linked_job: storedJob,
          binding_reusable:
            ['completed', 'failed', 'cancelled', 'expired'].includes(
              storedJob.status
            )
            && new Date(
              String(storedBinding.idempotency_until)
            ).getTime() <= Date.now()
        }])
        : rows();
    }
    if (
      sql.startsWith('UPDATE job_data')
      && sql.includes('expiryReconciledAt')
      && sql.includes('WHERE id = $1')
    ) {
      if (
        storedJob.id !== values[0]
        || storedJob.job_type !== values[1]
        || !['pending', 'running'].includes(storedJob.status)
        || storedJob.expires_at.getTime() > Date.now()
      ) {
        return rows();
      }
      const assignment = storedJob.input.job as Record<string, unknown>;
      const manualReconciliationRequired =
        storedJob.status === 'running' && assignment.mayModifyFiles === true;
      storedJob.status = manualReconciliationRequired ? 'failed' : 'expired';
      storedJob.error_message = manualReconciliationRequired
        ? 'Mutating local-agent assignment expired after execution began; manual reconciliation is required.'
        : 'Local-agent job expired before execution completed.';
      storedJob.completed_at = new Date();
      storedJob.lease_expires_at = null;
      storedJob.autonomy_state = {
        ...storedJob.autonomy_state,
        localAgent: {
          ...(storedJob.autonomy_state.localAgent as Record<string, unknown>),
          manualReconciliationRequired
        }
      };
      return rows([storedJob]);
    }
    if (
      sql.startsWith('UPDATE job_data')
      && sql.includes("status = 'expired'")
    ) {
      return rows();
    }
    if (
      sql.startsWith('UPDATE job_data')
      && sql.includes('manualReconciliationRequired')
    ) {
      return rows();
    }
    if (
      sql.startsWith('SELECT * FROM job_data')
      && sql.includes("claimKeyHash' =")
    ) {
      const localAgentState = storedJob.autonomy_state.localAgent as
        | Record<string, unknown>
        | undefined;
      return localAgentState?.claimKeyHash === values[2]
        ? rows([storedJob])
        : rows();
    }
    if (
      sql.startsWith('UPDATE job_data')
      && sql.includes('FOR UPDATE SKIP LOCKED')
    ) {
      if (storedJob.status !== 'pending') {
        return rows();
      }
      storedJob.status = 'running';
      storedJob.started_at = new Date();
      storedJob.last_heartbeat_at = new Date();
      storedJob.lease_expires_at = new Date(Date.now() + Number(values[0]));
      storedJob.last_worker_id = String(values[1]);
      storedJob.autonomy_state = {
        ...storedJob.autonomy_state,
        localAgent: {
          ...(storedJob.autonomy_state.localAgent as Record<string, unknown>),
          ...JSON.parse(String(values[2])) as Record<string, unknown>
        }
      };
      return rows([storedJob]);
    }
    if (
      sql.startsWith('SELECT * FROM job_data')
      && sql.includes('LIMIT 1 FOR UPDATE')
    ) {
      if (sql.includes('worker_id = $3')) {
        return storedJob.id === values[0] && storedJob.worker_id === values[2]
          ? rows([storedJob])
          : rows();
      }
      return storedJob.id === values[0] && storedJob.job_type === values[1]
        ? rows([storedJob])
        : rows();
    }
    if (
      sql.startsWith('UPDATE job_data')
      && sql.includes('output = $2::jsonb')
      && sql.includes("'{localAgent}'")
    ) {
      storedJob.status = String(values[0]);
      storedJob.output = JSON.parse(String(values[1])) as unknown;
      storedJob.error_message = values[2] ? String(values[2]) : null;
      storedJob.completed_at = new Date();
      storedJob.updated_at = new Date();
      storedJob.lease_expires_at = null;
      storedJob.autonomy_state = {
        ...storedJob.autonomy_state,
        localAgent: {
          ...(storedJob.autonomy_state.localAgent as Record<string, unknown>),
          ...JSON.parse(String(values[3])) as Record<string, unknown>
        }
      };
      return rows([storedJob]);
    }
    throw new Error(`Unhandled local-agent repository query: ${sql}`);
  })
} as unknown as PoolClient;

jest.unstable_mockModule('../src/core/db/client.js', () => ({
  isDatabaseConnected: () => true
}));
jest.unstable_mockModule('../src/core/db/query.js', () => ({
  transaction: async <T>(callback: (value: PoolClient) => Promise<T>) =>
    callback(client)
}));
jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  dbLogger: {
    warn: dbLoggerWarnMock
  }
}));
jest.unstable_mockModule(
  '../src/core/db/repositories/jobEventRepository.js',
  () => ({
    recordJobEvent: recordJobEventMock,
    recordJobEventWithClient: recordJobEventWithClientMock
  })
);

const {
  claimLocalAgentJob,
  findOrCreateLocalAgentJob,
  reconcileExpiredLocalAgentJob,
  submitLocalAgentJobResult
} = await import(
  '../src/core/db/repositories/localAgentJobRepository.js'
);

beforeEach(() => {
  storedJob = job();
  storedBinding = null;
  jest.clearAllMocks();
});

describe('local-agent durable job repository', () => {
  test('replays an identical database-bound idempotency request and conflicts on mutation', async () => {
    const options = {
      deviceId: storedJob.worker_id,
      envelope: storedJob.input as never,
      requestFingerprintHash: 'a'.repeat(64),
      idempotencyKeyHash: 'b'.repeat(64),
      idempotencyScopeHash: 'c'.repeat(64),
      idempotencyOrigin: 'explicit' as const,
      expiresAt: '2099-07-24T13:00:00.000Z',
      idempotencyUntil: '2099-07-25T13:00:00.000Z',
      retentionUntil: '2099-07-26T13:00:00.000Z'
    };

    const created = await findOrCreateLocalAgentJob(options);
    const replayed = await findOrCreateLocalAgentJob(options);

    expect(created).toMatchObject({
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    expect(replayed).toMatchObject({
      created: false,
      deduped: true,
      dedupeReason: 'reused_inflight_job',
      job: { id: created.job.id }
    });
    await expect(
      findOrCreateLocalAgentJob({
        ...options,
        requestFingerprintHash: 'd'.repeat(64)
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_IDEMPOTENCY_CONFLICT'
    });
  });

  test('retains an expired job result until its idempotency window closes', async () => {
    const options = {
      deviceId: storedJob.worker_id,
      envelope: storedJob.input as never,
      requestFingerprintHash: 'a'.repeat(64),
      idempotencyKeyHash: 'b'.repeat(64),
      idempotencyScopeHash: 'c'.repeat(64),
      idempotencyOrigin: 'explicit' as const,
      expiresAt: '2099-07-24T13:00:00.000Z',
      idempotencyUntil: '2099-07-25T13:00:00.000Z',
      retentionUntil: '2099-07-26T13:00:00.000Z'
    };

    const created = await findOrCreateLocalAgentJob(options);
    storedJob.status = 'expired';
    storedJob.completed_at = new Date();

    await expect(findOrCreateLocalAgentJob(options)).resolves.toMatchObject({
      created: false,
      deduped: true,
      dedupeReason: 'reused_terminal_result',
      job: { id: created.job.id, status: 'expired' }
    });
    await expect(
      findOrCreateLocalAgentJob({
        ...options,
        requestFingerprintHash: 'd'.repeat(64)
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_IDEMPOTENCY_CONFLICT'
    });
  });

  test('allows only one atomic device claim under a race', async () => {
    const results = await Promise.all([
      claimLocalAgentJob({
        deviceId: storedJob.worker_id,
        claimKeyHash: 'claim-a',
        leaseMs: 30_000,
        deviceScopes: ['git.status']
      }),
      claimLocalAgentJob({
        deviceId: storedJob.worker_id,
        claimKeyHash: 'claim-b',
        leaseMs: 30_000,
        deviceScopes: ['git.status']
      })
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      disposition: 'CLAIMED',
      job: { id: storedJob.id, status: 'running' }
    });
    expect(
      (client.query as jest.Mock).mock.calls.some(
        ([sql]) => String(sql).includes('FOR UPDATE SKIP LOCKED')
      )
    ).toBe(true);
    expect(recordJobEventWithClientMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        jobId: storedJob.id,
        eventType: 'job.claimed',
        traceId: 'trace:test',
        metadata: expect.objectContaining({
          action: 'git.status',
          workspace: 'personal',
          requestId: 'request:test',
          deviceId: storedJob.worker_id
        })
      })
    );
  });

  test('replays the same claim without executing a second claim', async () => {
    const first = await claimLocalAgentJob({
      deviceId: storedJob.worker_id,
      claimKeyHash: 'claim-retry',
      leaseMs: 30_000,
      deviceScopes: ['git.status']
    });
    const second = await claimLocalAgentJob({
      deviceId: storedJob.worker_id,
      claimKeyHash: 'claim-retry',
      leaseMs: 30_000,
      deviceScopes: ['git.status']
    });

    expect(first?.disposition).toBe('CLAIMED');
    expect(second?.disposition).toBe('CLAIM_REPLAY');
  });

  test('accepts an exact terminal result replay and rejects a different result', async () => {
    storedJob.status = 'running';
    storedJob.last_worker_id = storedJob.worker_id;
    storedJob.lease_expires_at = new Date(Date.now() + 30_000);
    const base = {
      jobId: storedJob.id,
      deviceId: storedJob.worker_id,
      resultKeyHash: 'result-key',
      resultFingerprintHash: 'result-fingerprint',
      outcome: 'succeeded' as const,
      output: {
        clean: true,
        changes: [],
        gitAvailable: true,
        workspaceType: 'git'
      },
      metrics: { durationMs: 10, outputTruncated: false },
      correlation: {
        traceId: 'trace:test',
        requestId: 'request:test',
        deviceId: storedJob.worker_id
      }
    };

    await expect(submitLocalAgentJobResult(base)).resolves.toMatchObject({
      replayed: false,
      job: { status: 'completed' }
    });
    await expect(submitLocalAgentJobResult(base)).resolves.toMatchObject({
      replayed: true,
      job: { status: 'completed' }
    });
    await expect(
      submitLocalAgentJobResult({
        ...base,
        resultFingerprintHash: 'different-result'
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_RESULT_CONFLICT'
    });
    expect(recordJobEventWithClientMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        jobId: storedJob.id,
        eventType: 'job.completed',
        traceId: 'trace:test',
        metadata: expect.objectContaining({
          action: 'git.status',
          workspace: 'personal',
          requestId: 'request:test',
          deviceId: storedJob.worker_id,
          durationMs: 10
        })
      })
    );
  });

  test('marks an unknown local effect outcome for manual reconciliation', async () => {
    storedJob.status = 'running';
    storedJob.last_worker_id = storedJob.worker_id;
    storedJob.lease_expires_at = new Date(Date.now() + 30_000);

    await expect(
      submitLocalAgentJobResult({
        jobId: storedJob.id,
        deviceId: storedJob.worker_id,
        resultKeyHash: 'unknown-effect-key',
        resultFingerprintHash: 'unknown-effect-fingerprint',
        outcome: 'failed',
        error: {
          code: 'LOCAL_EFFECT_OUTCOME_UNKNOWN',
          message: 'The local effect outcome could not be determined.',
          classification: 'unknown_effect',
          retryable: false
        },
        metrics: { durationMs: 10, outputTruncated: false },
        correlation: {
          traceId: 'trace:test',
          requestId: 'request:test',
          deviceId: storedJob.worker_id
        }
      })
    ).resolves.toMatchObject({
      replayed: false,
      job: {
        status: 'failed',
        autonomy_state: {
          localAgent: { manualReconciliationRequired: true }
        }
      }
    });
    expect(recordJobEventWithClientMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        jobId: storedJob.id,
        eventType: 'job.failed',
        traceId: 'trace:test',
        metadata: expect.objectContaining({
          failureCode: 'LOCAL_EFFECT_OUTCOME_UNKNOWN',
          manualReconciliationRequired: true
        })
      })
    );
  });

  test('rejects a result submitted after the server-controlled job expiry', async () => {
    storedJob.status = 'running';
    storedJob.last_worker_id = storedJob.worker_id;
    storedJob.lease_expires_at = new Date(Date.now() + 30_000);
    storedJob.expires_at = new Date(Date.now() - 1);

    await expect(
      submitLocalAgentJobResult({
        jobId: storedJob.id,
        deviceId: storedJob.worker_id,
        resultKeyHash: 'late-result-key',
        resultFingerprintHash: 'late-result-fingerprint',
        outcome: 'succeeded',
        output: {
          clean: true,
          changes: [],
          gitAvailable: true,
          workspaceType: 'git'
        },
        metrics: { durationMs: 10, outputTruncated: false },
        correlation: {
          traceId: 'trace:test',
          requestId: 'request:test',
          deviceId: storedJob.worker_id
        }
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_JOB_LEASE_EXPIRED'
    });
  });

  test('rejects result correlation that differs from the authorized assignment', async () => {
    storedJob.status = 'running';
    storedJob.last_worker_id = storedJob.worker_id;
    storedJob.lease_expires_at = new Date(Date.now() + 30_000);

    await expect(
      submitLocalAgentJobResult({
        jobId: storedJob.id,
        deviceId: storedJob.worker_id,
        resultKeyHash: 'result-key',
        resultFingerprintHash: 'result-fingerprint',
        outcome: 'succeeded',
        output: {
          clean: true,
          changes: [],
          gitAvailable: true,
          workspaceType: 'git'
        },
        metrics: { durationMs: 10, outputTruncated: false },
        correlation: {
          traceId: 'trace:attacker',
          requestId: 'request:test',
          deviceId: storedJob.worker_id
        }
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_RESULT_CORRELATION_MISMATCH'
    });
    expect(storedJob.status).toBe('running');
  });

  test('fails an expired running mutation for manual reconciliation without replay', async () => {
    storedJob.status = 'running';
    storedJob.last_worker_id = storedJob.worker_id;
    storedJob.lease_expires_at = new Date(Date.now() + 30_000);
    storedJob.expires_at = new Date(Date.now() - 1);
    (storedJob.input.job as Record<string, unknown>).action = 'patch.apply';
    (storedJob.input.job as Record<string, unknown>).readOnly = false;
    (storedJob.input.job as Record<string, unknown>).mayModifyFiles = true;

    await expect(
      reconcileExpiredLocalAgentJob(storedJob.id)
    ).resolves.toMatchObject({
      id: storedJob.id,
      status: 'failed',
      autonomy_state: {
        localAgent: { manualReconciliationRequired: true }
      }
    });
    expect(recordJobEventWithClientMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        jobId: storedJob.id,
        eventType: 'job.failed',
        traceId: 'trace:test',
        metadata: expect.objectContaining({
          failureCode: 'LOCAL_AGENT_MANUAL_RECONCILIATION_REQUIRED',
          manualReconciliationRequired: true
        })
      })
    );
  });

  test('isolates one expiry-event failure and continues the bounded recovery batch', async () => {
    const firstExpiredJob = job();
    firstExpiredJob.id = '10000000-0000-4000-8000-000000000011';
    firstExpiredJob.expires_at = new Date(Date.now() - 1);
    const secondExpiredJob = job();
    secondExpiredJob.id = '10000000-0000-4000-8000-000000000012';
    secondExpiredJob.expires_at = new Date(Date.now() - 1);
    const recoveryJobs = [firstExpiredJob, secondExpiredJob];
    const originalQueryImplementation = (
      client.query as jest.Mock
    ).getMockImplementation();

    (client.query as jest.Mock).mockImplementation(
      async (rawSql: unknown, values: unknown[] = []) => {
        const sql = String(rawSql).replace(/\s+/gu, ' ').trim();
        if (
          sql.startsWith('SELECT pg_advisory_xact_lock')
          || sql.startsWith('SAVEPOINT ')
          || sql.startsWith('ROLLBACK TO SAVEPOINT ')
          || sql.startsWith('RELEASE SAVEPOINT ')
        ) {
          return rows();
        }
        if (
          sql.startsWith('SELECT * FROM job_data')
          && sql.includes('ORDER BY COALESCE(expires_at, lease_expires_at)')
        ) {
          return rows(recoveryJobs);
        }
        if (
          sql.startsWith('UPDATE job_data')
          && sql.includes('expiryReconciledAt')
        ) {
          const candidate = recoveryJobs.find((entry) => entry.id === values[0]);
          if (!candidate) {
            return rows();
          }
          candidate.status = 'expired';
          candidate.completed_at = new Date();
          candidate.lease_expires_at = null;
          return rows([candidate]);
        }
        if (
          sql.startsWith('SELECT * FROM job_data')
          && sql.includes("claimKeyHash' =")
        ) {
          return rows();
        }
        if (
          sql.startsWith('UPDATE job_data')
          && sql.includes('FOR UPDATE SKIP LOCKED')
        ) {
          return rows();
        }
        throw new Error(`Unhandled recovery query: ${sql}`);
      }
    );
    recordJobEventWithClientMock
      .mockRejectedValueOnce(new Error('synthetic event insert failure'))
      .mockResolvedValue(undefined);

    try {
      await expect(
        claimLocalAgentJob({
          deviceId: storedJob.worker_id,
          claimKeyHash: 'recovery-claim',
          leaseMs: 30_000,
          deviceScopes: ['git.status']
        })
      ).resolves.toBeNull();
    } finally {
      if (originalQueryImplementation) {
        (client.query as jest.Mock).mockImplementation(
          originalQueryImplementation
        );
      }
    }

    expect(
      (client.query as jest.Mock).mock.calls.some(
        ([sql]) => String(sql).startsWith('ROLLBACK TO SAVEPOINT ')
      )
    ).toBe(true);
    expect(recordJobEventWithClientMock).toHaveBeenCalledTimes(2);
    expect(recordJobEventWithClientMock).toHaveBeenLastCalledWith(
      client,
      expect.objectContaining({
        jobId: secondExpiredJob.id,
        eventType: 'job.expired',
        traceId: 'trace:test',
        metadata: expect.objectContaining({
          reason: 'job_expired_before_completion',
          finalStatus: 'expired'
        })
      })
    );
  });
});
