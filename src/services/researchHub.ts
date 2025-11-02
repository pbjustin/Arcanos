import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import { researchTopic, ResearchResult } from './research.js';

export interface ResearchHubRequest {
  topic: string;
  urls?: string[];
  metadata?: Record<string, unknown>;
}

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

function normalizeRequest(request: ResearchHubRequest): ResearchHubEventBase['request'] {
  const topic = request.topic?.trim();
  if (!topic) {
    throw new Error('Research topic is required');
  }

  const urls = Array.isArray(request.urls)
    ? request.urls.filter(url => typeof url === 'string' && url.trim().length > 0)
    : [];

  const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : undefined;

  return {
    topic,
    urls,
    metadata
  };
}

class ResearchHub {
  private emitter = new EventEmitter();

  async request(requester: string, request: ResearchHubRequest): Promise<ResearchResult> {
    const normalized = normalizeRequest(request);
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();

    this.emit({
      type: 'started',
      requestId,
      requester,
      timestamp: startedAt,
      request: normalized
    });

    try {
      const result = await researchTopic(normalized.topic, normalized.urls);
      const completedEvent: ResearchHubCompletedEvent = {
        type: 'completed',
        requestId,
        requester,
        timestamp: new Date().toISOString(),
        request: normalized,
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
        request: normalized,
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
  requestResearch: (request: ResearchHubRequest) => Promise<ResearchResult>;
  subscribe: (listener: ResearchHubListener, options?: { includeForeign?: boolean }) => () => void;
}

export function connectResearchBridge(moduleName: string): ResearchBridge {
  return {
    requestResearch: request => hub.request(moduleName, request),
    subscribe: (listener, options) => hub.subscribe(moduleName, listener, options)
  };
}

export function observeResearchEvents(listener: ResearchHubListener): () => void {
  return hub.subscribe('*', listener, { includeForeign: true });
}

export async function requestResearchViaHub(
  requester: string,
  request: ResearchHubRequest
): Promise<ResearchResult> {
  return hub.request(requester, request);
}

