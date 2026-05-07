import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listJobEventTimelineMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  listJobEventTimeline: listJobEventTimelineMock
}));

const {
  formatJobEventTimeline,
  getJobEventTimeline
} = await import('../src/services/jobEventTimelineService.js');

describe('jobEventTimelineService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds chronological summaries and latency edges', async () => {
    listJobEventTimelineMock.mockResolvedValue({
      available: true,
      events: [
        {
          id: 'event-1',
          jobId: 'job-1',
          traceId: 'trace-1',
          eventType: 'job.queued',
          workerId: null,
          occurredAt: '2026-05-07T12:00:00.000Z',
          durationMs: null,
          metadata: {}
        },
        {
          id: 'event-2',
          jobId: 'job-1',
          traceId: 'trace-1',
          eventType: 'job.claimed',
          workerId: 'worker-1',
          occurredAt: '2026-05-07T12:00:03.000Z',
          durationMs: null,
          metadata: {}
        },
        {
          id: 'event-3',
          jobId: 'job-1',
          traceId: 'trace-1',
          eventType: 'ai.request.started',
          workerId: 'worker-1',
          occurredAt: '2026-05-07T12:00:05.000Z',
          durationMs: null,
          metadata: {}
        },
        {
          id: 'event-4',
          jobId: 'job-1',
          traceId: 'trace-1',
          eventType: 'ai.request.completed',
          workerId: 'worker-1',
          occurredAt: '2026-05-07T12:00:08.000Z',
          durationMs: 3_000,
          metadata: {}
        },
        {
          id: 'event-5',
          jobId: 'job-1',
          traceId: 'trace-1',
          eventType: 'job.completed',
          workerId: 'worker-1',
          occurredAt: '2026-05-07T12:00:10.000Z',
          durationMs: null,
          metadata: {}
        }
      ]
    });

    const result = await getJobEventTimeline({ jobId: 'job-1' });

    expect(result.available).toBe(true);
    expect(result.summary).toEqual(expect.objectContaining({
      eventCount: 5,
      spanMs: 10_000,
      traceIds: ['trace-1'],
      workerIds: ['worker-1'],
      latencyMs: {
        queueWait: 3_000,
        execution: null,
        provider: 3_000
      }
    }));
    expect(result.events[1]?.offsetMs).toBe(3_000);
    expect(formatJobEventTimeline(result.events)).toContain('job.claimed worker=worker-1 trace=trace-1');
  });

  it('preserves unavailable timeline reasons', async () => {
    listJobEventTimelineMock.mockResolvedValue({
      available: false,
      reason: 'database_unavailable',
      events: []
    });

    await expect(getJobEventTimeline({ traceId: 'trace-1' })).resolves.toEqual({
      available: false,
      reason: 'database_unavailable',
      events: [],
      summary: expect.objectContaining({
        eventCount: 0
      })
    });
  });
});
