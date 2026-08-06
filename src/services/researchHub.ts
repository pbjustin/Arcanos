import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import { normalizeResearchRequest } from '@shared/researchRequest.js';
import { createAbortError, getRequestAbortContext } from '@arcanos/runtime';
import {
  researchTopic,
  type ResearchExecutionOptions,
  type ResearchResult,
} from './research.js';

export interface ResearchHubRequest {
  topic: string;
  urls?: string[];
  metadata?: Record<string, unknown>;
}

export type ResearchHubExecutionOptions = Omit<
  ResearchExecutionOptions,
  'requestId'
>;

export type ResearchHubEventType = 'started' | 'completed' | 'failed';

export interface ResearchHubEventBase {
  type: ResearchHubEventType;
  requestId: string;
  requester: string;
  timestamp: string;
  request: Required<Pick<ResearchHubRequest, 'topic'>> & {
    urls: string[];
    metadata?: Record<string, unknown>;
  };
}

export interface ResearchHubCompletedEvent extends ResearchHubEventBase {
  type: 'completed';
  result: ResearchResult;
}

export interface ResearchHubFailedEvent extends ResearchHubEventBase {
  type: 'failed';
  error: string;
}

export type ResearchHubEvent =
  | ResearchHubEventBase & { type: 'started' }
  | ResearchHubCompletedEvent
  | ResearchHubFailedEvent;

type ResearchHubListener = (event: ResearchHubEvent) => void;

function throwIfResearchHubAborted(...signals: Array<AbortSignal | undefined>): void {
  const abortedSignal = signals.find(signal => signal?.aborted);
  if (!abortedSignal) {
    return;
  }

  throw abortedSignal.reason instanceof Error
    ? abortedSignal.reason
    : createAbortError('Research request aborted');
}

function throwIfResearchHubDeadlineExpired(deadlineAt: number | undefined): void {
  if (typeof deadlineAt !== 'number' || Date.now() < deadlineAt) {
    return;
  }

  throw createAbortError('Research request parent deadline already expired');
}

function buildEventRequest(
  request: ResearchHubEventBase['request'],
): ResearchHubEventBase['request'] {
  return {
    topic: request.topic,
    urls: [...request.urls],
    metadata: request.metadata,
  };
}

class ResearchHub {
  private emitter = new EventEmitter();

  async request(
    requester: string,
    request: ResearchHubRequest,
    executionOptions: ResearchHubExecutionOptions = {},
  ): Promise<ResearchResult> {
    const ambientContext = getRequestAbortContext();
    const ambientSignal = ambientContext?.signal;
    throwIfResearchHubAborted(executionOptions.signal, ambientSignal);
    throwIfResearchHubDeadlineExpired(ambientContext?.deadlineAt);
    const normalized = normalizeResearchRequest(request);
    const executionUrls: readonly string[] = Object.freeze([...normalized.urls]);
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();

    this.emit({
      type: 'started',
      requestId,
      requester,
      timestamp: startedAt,
      request: buildEventRequest(normalized),
    });

    try {
      // A synchronous event listener can consume the remaining request time.
      // Recheck before admitting provider, fetch, or persistence work.
      throwIfResearchHubAborted(executionOptions.signal, ambientSignal);
      throwIfResearchHubDeadlineExpired(ambientContext?.deadlineAt);
      const result = await researchTopic(normalized.topic, executionUrls, {
        ...executionOptions,
        requestId,
      });
      // Do not emit a successful completion when caller cancellation wins the
      // continuation race immediately after the workflow itself drains.
      throwIfResearchHubAborted(executionOptions.signal, ambientSignal);
      throwIfResearchHubDeadlineExpired(ambientContext?.deadlineAt);
      const completedEvent: ResearchHubCompletedEvent = {
        type: 'completed',
        requestId,
        requester,
        timestamp: new Date().toISOString(),
        request: buildEventRequest(normalized),
        result
      };
      this.emit(completedEvent);
      return result;
    } catch (error) {
      const failedEvent: ResearchHubFailedEvent = {
        type: 'failed',
        requestId,
        requester,
        timestamp: new Date().toISOString(),
        request: buildEventRequest(normalized),
        error: (error as Error).message
      };
      this.emit(failedEvent);
      throw error;
    }
  }

  subscribe(moduleName: string, listener: ResearchHubListener, options: { includeForeign?: boolean } = {}): () => void {
    const includeForeign = Boolean(options.includeForeign);

    const wrapped: ResearchHubListener = event => {
      if (includeForeign || event.requester === moduleName) {
        listener(event);
      }
    };

    this.emitter.on('event', wrapped);

    return () => {
      this.emitter.off('event', wrapped);
    };
  }

  private emit(event: ResearchHubEvent): void {
    this.emitter.emit('event', event);
  }
}

const hub = new ResearchHub();

export interface ResearchBridge {
  requestResearch: (
    request: ResearchHubRequest,
    executionOptions?: ResearchHubExecutionOptions,
  ) => Promise<ResearchResult>;
  subscribe: (listener: ResearchHubListener, options?: { includeForeign?: boolean }) => () => void;
}

export function connectResearchBridge(moduleName: string): ResearchBridge {
  return {
    requestResearch: (request, executionOptions) =>
      hub.request(moduleName, request, executionOptions),
    subscribe: (listener, options) => hub.subscribe(moduleName, listener, options)
  };
}

export function observeResearchEvents(listener: ResearchHubListener): () => void {
  return hub.subscribe('*', listener, { includeForeign: true });
}

export async function requestResearchViaHub(
  requester: string,
  request: ResearchHubRequest,
  executionOptions?: ResearchHubExecutionOptions,
): Promise<ResearchResult> {
  return hub.request(requester, request, executionOptions);
}

