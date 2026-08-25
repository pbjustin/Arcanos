import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const recordJobEventMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('../src/core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock,
  recordJobEventWithClient: jest.fn()
}));

const {
  failPendingJobIfUnclaimed,
  normalizeJobClaimGeneration,
  recordJobHeartbeat,
  scheduleJobRetry,
  updateClaimedJobTerminal,
  updateJob
} = await import('../src/core/db/repositories/jobRepository.js');
const fence = {
  workerId: 'worker-1',
  claimGeneration: '7'
};

describe('jobRepository.updateJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.JOB_EVENT_RECORD_HEARTBEATS;
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [{ id: 'job-1', status: 'cancelled', claim_generation: '7' }]
    });
  });

  it('casts the status parameter consistently to avoid PostgreSQL type inference failures', async () => {
    await updateJob(
      'job-1',
      'cancelled',
      { ok: false },
      'Job cancellation requested by client.',
      undefined,
      { cancelRequestedAt: '2026-04-06T21:00:00.000Z' }
    );

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('status = $1::varchar(50)');
    expect(sql).toContain("WHEN $1::varchar(50) = 'expired'::varchar(50)");
    expect(sql).toContain("WHEN $1::varchar(50) = 'cancelled'::varchar(50)");
    expect(sql).toContain("status NOT IN ('completed', 'failed', 'cancelled', 'expired')");
  });

  it('applies shared ask and DAG-node retention windows from the database clock', async () => {
    await updateJob('job-1', 'completed', { ok: true });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHEN 'ask' THEN CASE");
    expect(sql).toContain("WHEN 'dag-node' THEN CASE");
    expect(sql).toContain(
      "THEN NOW() + ($13::bigint * INTERVAL '1 millisecond')"
    );
    expect(sql).toContain(
      "THEN NOW() + ($14::bigint * INTERVAL '1 millisecond')"
    );
    expect(sql).not.toContain("WHEN 'gpt'");
    expect(params[12]).toBe(24 * 60 * 60 * 1_000);
    expect(params[13]).toBe(60 * 60 * 1_000);
  });

  it('does not add a generic repository fallback for GPT lifecycle metadata', async () => {
    await updateJob('job-1', 'completed', { ok: true });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("WHEN 'gpt'");
    expect(params).toHaveLength(15);
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
  });

  it('keeps explicit and already-persisted lifecycle metadata ahead of computed fallbacks', async () => {
    await updateJob(
      'job-1',
      'cancelled',
      null,
      'cancelled',
      undefined,
      { retentionUntil: '2026-08-10T12:00:00.000Z' }
    );

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      '$8::timestamptz,\n         retention_until,\n         CASE job_type'
    );
    expect(params[7]).toBe('2026-08-10T12:00:00.000Z');
  });

  it('blocks unfenced terminal mutation of a running row and emits no terminal event', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-running',
        worker_id: 'queue',
        job_type: 'gpt',
        status: 'running',
        claim_generation: '7',
        __arcanos_updated: false
      }]
    });

    await expect(updateJob(
      'job-running',
      'completed',
      { ok: true }
    )).resolves.toEqual(expect.objectContaining({
      id: 'job-running',
      status: 'running'
    }));

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("OR status <> 'running'");
    expect(sql).toContain('FALSE AS __arcanos_updated');
    expect(recordJobEventMock).not.toHaveBeenCalled();
  });

  it('fails an exact pending generation only while it has no live lease', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-pending',
        worker_id: 'queue',
        job_type: 'dag-node',
        status: 'failed',
        claim_generation: '0'
      }]
    });

    await expect(failPendingJobIfUnclaimed('job-pending', {
      claimGeneration: '0',
      output: null,
      errorMessage: 'claim timeout'
    })).resolves.toEqual(expect.objectContaining({
      id: 'job-pending',
      status: 'failed'
    }));

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("AND status = 'pending'");
    expect(sql).toContain('AND claim_generation = $5::bigint');
    expect(sql).toContain('AND lease_expires_at IS NULL');
    expect(params.slice(-2)).toEqual(['job-pending', '0']);
    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'job.failed',
      metadata: expect.objectContaining({
        claimGeneration: '0',
        timeoutBeforeClaim: true
      })
    }));
  });

  it('returns null without an event when a pending-timeout CAS loses its race', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(failPendingJobIfUnclaimed('job-pending', {
      claimGeneration: '0',
      errorMessage: 'claim timeout'
    })).resolves.toBeNull();

    expect(recordJobEventMock).not.toHaveBeenCalled();
  });

  it('clears stale started_at when scheduling a retry', async () => {
    await scheduleJobRetry('job-1', {
      delayMs: 500,
      errorMessage: 'retry this job',
      fence
    });

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('started_at = NULL');
    expect(sql).toContain('AND cancel_requested_at IS NULL');
    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'job.retry.scheduled',
      metadata: expect.objectContaining({
        claimGeneration: '7'
      })
    }));
  });

  it('only heartbeats a job still owned by the supplied worker lease', async () => {
    await recordJobHeartbeat('job-1', {
      fence,
      leaseMs: 15_000
    });

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("AND status = 'running'");
    expect(sql).toContain('last_worker_id = $2::text');
    expect(sql).toContain('claim_generation = $3::bigint');
    expect(sql).toContain('lease_expires_at IS NOT NULL');
    expect(sql).toContain('lease_expires_at >= NOW()');
  });

  it('returns null without an event when the exact heartbeat fence no longer matches', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(recordJobHeartbeat('job-1', {
      fence,
      leaseMs: 15_000
    })).resolves.toBeNull();

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("AND status = 'running'");
    expect(sql).toContain('AND last_worker_id = $2::text');
    expect(sql).toContain('AND claim_generation = $3::bigint');
    expect(sql).toContain('AND lease_expires_at >= NOW()');
    expect(params).toEqual([15_000, 'worker-1', '7', 'job-1']);
    expect(recordJobEventMock).not.toHaveBeenCalled();
  });

  it('does not emit high-frequency heartbeat job events by default', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        status: 'running',
        job_type: 'gpt',
        worker_id: 'worker-1',
        last_worker_id: 'worker-1',
        claim_generation: '7'
      }]
    });

    await recordJobHeartbeat('job-1', {
      fence,
      leaseMs: 15_000
    });

    expect(recordJobEventMock).not.toHaveBeenCalled();
  });

  it('can opt into heartbeat job events for short lease debugging windows', async () => {
    process.env.JOB_EVENT_RECORD_HEARTBEATS = 'true';
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        status: 'running',
        job_type: 'gpt',
        worker_id: 'worker-1',
        last_worker_id: 'worker-1',
        claim_generation: '7'
      }]
    });

    await recordJobHeartbeat('job-1', {
      fence,
      leaseMs: 15_000
    });

    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-1',
      eventType: 'worker.heartbeat',
      workerId: 'worker-1',
      metadata: expect.objectContaining({
        leaseMs: 15_000,
        claimGeneration: '7'
      })
    }));
  });

  it.each(['failed', 'cancelled', 'timed-out'])(
    'does not schedule retry after a terminal %s race',
    async () => {
      queryMock.mockResolvedValueOnce({
        rows: []
      });

      const result = await scheduleJobRetry('job-1', {
        delayMs: 500,
        errorMessage: 'retry this job',
        fence
      });

      const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

      expect(result).toBeNull();
      expect(sql).toContain("AND status = 'running'");
      expect(sql).toContain('last_worker_id = $5::text');
      expect(sql).not.toContain('OR last_worker_id IS NULL');
      expect(sql).toContain('claim_generation = $6::bigint');
      expect(sql).toContain('lease_expires_at IS NOT NULL');
      expect(sql).toContain('lease_expires_at >= NOW()');
      expect(sql).not.toContain('OR lease_expires_at IS NULL');
    }
  );

  it('keeps BIGINT claim generations as validated decimal strings', () => {
    expect(normalizeJobClaimGeneration('9223372036854775807')).toBe(
      '9223372036854775807'
    );
    expect(() => normalizeJobClaimGeneration(7)).toThrow(
      'must be a non-negative decimal string'
    );
    expect(() => normalizeJobClaimGeneration('07')).toThrow(
      'must be a non-negative decimal string'
    );
    expect(() => normalizeJobClaimGeneration('9223372036854775808')).toThrow(
      'exceeds the PostgreSQL BIGINT range'
    );
    expect(() => normalizeJobClaimGeneration('9'.repeat(10_000))).toThrow(
      'exceeds the PostgreSQL BIGINT range'
    );
  });

  it('fences terminal updates by owner, generation, and live lease without a fallback row', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        status: 'completed',
        job_type: 'gpt',
        worker_id: 'queue',
        last_worker_id: 'worker-1',
        claim_generation: '7'
      }]
    });

    await expect(updateClaimedJobTerminal('job-1', 'completed', {
      fence,
      output: { ok: true }
    })).resolves.toEqual(expect.objectContaining({
      status: 'completed',
      claim_generation: '7'
    }));

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("AND status = 'running'");
    expect(sql).toContain('AND last_worker_id = $11::text');
    expect(sql).toContain('AND claim_generation = $12::bigint');
    expect(sql).toContain('AND lease_expires_at IS NOT NULL');
    expect(sql).toContain('AND lease_expires_at >= NOW()');
    expect(sql).toContain("$1::varchar(50) = 'cancelled'::varchar(50)");
    expect(sql).toContain("$1::varchar(50) = 'completed'::varchar(50)");
    expect(sql).toContain('AND $16::boolean');
    expect(sql).toContain('OR cancel_requested_at IS NULL');
    expect(sql).not.toContain('current_job');
    expect(sql).not.toContain('UNION ALL');
    expect(params.slice(9, 12)).toEqual(['job-1', 'worker-1', '7']);
    expect(params[12]).toBe(24 * 60 * 60 * 1_000);
    expect(params[13]).toBe(60 * 60 * 1_000);
    expect(params[14]).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(params[15]).toBe(false);
    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'job.completed',
      metadata: expect.objectContaining({
        claimGeneration: '7'
      })
    }));
  });

  it('can let a completed result win a late cancellation request behind the live fence', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        status: 'completed',
        job_type: 'gpt',
        worker_id: 'queue',
        last_worker_id: 'worker-1',
        claim_generation: '7'
      }]
    });

    await updateClaimedJobTerminal('job-1', 'completed', {
      fence,
      output: { ok: true },
      allowCompletionAfterCancellationRequest: true
    });

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[15]).toBe(true);
  });

  it('emits a generation-tagged event for fenced cancellation', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        status: 'cancelled',
        job_type: 'gpt',
        worker_id: 'queue',
        last_worker_id: 'worker-1',
        claim_generation: '7'
      }]
    });

    await expect(updateClaimedJobTerminal('job-1', 'cancelled', {
      fence,
      errorMessage: 'cancelled by request'
    })).resolves.toEqual(expect.objectContaining({
      status: 'cancelled',
      claim_generation: '7'
    }));

    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'job.cancelled',
      metadata: expect.objectContaining({
        claimGeneration: '7'
      })
    }));
  });

  it('returns null on a terminal fence miss and emits no terminal event', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(updateClaimedJobTerminal('job-1', 'failed', {
      fence,
      errorMessage: 'stale worker'
    })).resolves.toBeNull();

    expect(recordJobEventMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported claimed terminal statuses before querying', async () => {
    await expect(updateClaimedJobTerminal(
      'job-1',
      'expired' as never,
      { fence }
    )).rejects.toThrow(
      'must be completed, failed, or cancelled'
    );

    expect(queryMock).not.toHaveBeenCalled();
  });
});
