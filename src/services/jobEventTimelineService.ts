import {
  listJobEventTimeline,
  type JobEventTimelineRow,
  type ListJobEventTimelineInput
} from '@core/db/repositories/jobEventRepository.js';
import { redactSensitive } from '@shared/redaction.js';

export interface JobEventTimelineSummary {
  eventCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  spanMs: number | null;
  eventTypes: Record<string, number>;
  traceIds: string[];
  workerIds: string[];
  retryCount: number;
  terminalState: string | null;
  latencyMs: {
    queueWait: number | null;
    execution: number | null;
    provider: number | null;
  };
}

export interface JobEventTimelineEvent extends JobEventTimelineRow {
  offsetMs: number | null;
}

export type JobEventTimelineResult =
  | {
      available: true;
      events: JobEventTimelineEvent[];
      summary: JobEventTimelineSummary;
    }
  | {
      available: false;
      reason: 'database_unavailable' | 'table_unavailable' | 'query_failed';
      events: [];
      summary: JobEventTimelineSummary;
    };

function emptySummary(): JobEventTimelineSummary {
  return {
    eventCount: 0,
    firstOccurredAt: null,
    lastOccurredAt: null,
    spanMs: null,
    eventTypes: {},
    traceIds: [],
    workerIds: [],
    retryCount: 0,
    terminalState: null,
    latencyMs: {
      queueWait: null,
      execution: null,
      provider: null
    }
  };
}

function parseTime(value: string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function diffMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) {
    return null;
  }
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  return startMs === null || endMs === null ? null : Math.max(0, endMs - startMs);
}

function firstEventAt(events: JobEventTimelineRow[], eventType: string): string | null {
  return events.find((event) => event.eventType === eventType)?.occurredAt ?? null;
}

function lastEventAt(events: JobEventTimelineRow[], eventType: string): string | null {
  return [...events].reverse().find((event) => event.eventType === eventType)?.occurredAt ?? null;
}

function resolveTerminalState(events: JobEventTimelineRow[]): string | null {
  const terminalEvent = [...events].reverse().find((event) =>
    event.eventType === 'job.completed'
    || event.eventType === 'job.failed'
  );

  if (!terminalEvent) {
    return null;
  }

  return terminalEvent.eventType === 'job.completed' ? 'completed' : 'failed';
}

function firstDurationMs(events: JobEventTimelineRow[], eventType: string): number | null {
  const durationMs = events.find((event) => event.eventType === eventType)?.durationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, durationMs) : null;
}

function summarize(events: JobEventTimelineRow[]): JobEventTimelineSummary {
  if (events.length === 0) {
    return emptySummary();
  }

  const firstOccurredAt = events[0]?.occurredAt ?? null;
  const lastOccurredAt = events[events.length - 1]?.occurredAt ?? null;
  const eventTypes: Record<string, number> = {};
  const traceIds = new Set<string>();
  const workerIds = new Set<string>();

  for (const event of events) {
    eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1;
    if (event.traceId) {
      traceIds.add(event.traceId);
    }
    if (event.workerId) {
      workerIds.add(event.workerId);
    }
  }

  return {
    eventCount: events.length,
    firstOccurredAt,
    lastOccurredAt,
    spanMs: diffMs(firstOccurredAt, lastOccurredAt),
    eventTypes,
    traceIds: [...traceIds].sort(),
    workerIds: [...workerIds].sort(),
    retryCount: eventTypes['job.retry.scheduled'] ?? 0,
    terminalState: resolveTerminalState(events),
    latencyMs: {
      queueWait: diffMs(firstEventAt(events, 'job.queued'), firstEventAt(events, 'job.claimed')),
      execution: diffMs(firstEventAt(events, 'job.started'), lastEventAt(events, 'job.completed') ?? lastEventAt(events, 'job.failed')),
      provider: firstDurationMs(events, 'ai.request.completed')
        ?? firstDurationMs(events, 'ai.request.failed')
        ?? diffMs(firstEventAt(events, 'ai.request.started'), lastEventAt(events, 'ai.request.completed') ?? lastEventAt(events, 'ai.request.failed'))
    }
  };
}

export async function getJobEventTimeline(
  input: ListJobEventTimelineInput = {}
): Promise<JobEventTimelineResult> {
  const result = await listJobEventTimeline(input);
  if (!result.available) {
    return {
      available: false,
      reason: result.reason,
      events: [],
      summary: emptySummary()
    };
  }

  const firstMs = result.events.length > 0 ? parseTime(result.events[0].occurredAt) : null;
  const events = result.events.map((event) => {
    const currentMs = parseTime(event.occurredAt);
    return {
      ...event,
      metadata: redactSensitive(event.metadata) as Record<string, unknown>,
      offsetMs: firstMs === null || currentMs === null ? null : Math.max(0, currentMs - firstMs)
    };
  });

  return {
    available: true,
    events,
    summary: summarize(events)
  };
}

export function formatJobEventTimeline(events: JobEventTimelineEvent[]): string {
  if (events.length === 0) {
    return 'No job events found.';
  }

  return events
    .map((event) => {
      const offset = event.offsetMs === null ? '+?' : `+${event.offsetMs}ms`;
      const worker = event.workerId ? ` worker=${event.workerId}` : '';
      const trace = event.traceId ? ` trace=${event.traceId}` : '';
      return `${offset} ${event.occurredAt} ${event.eventType}${worker}${trace}`;
    })
    .join('\n');
}
