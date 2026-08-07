import type { ModuleDef } from './moduleLoader.js';
import {
  normalizeResearchModulePayload,
  RESEARCH_MODULE_NAME,
} from '@shared/researchRequest.js';
import { requestResearchViaHub } from './researchHub.js';
import { getRequestAbortSignal } from '@arcanos/runtime';
import { DEFAULT_RESEARCH_WORKFLOW_TIMEOUT_MS } from './research.js';

const ArcanosResearch: ModuleDef = {
  name: RESEARCH_MODULE_NAME,
  description: 'Research orchestration module backed by the shared research bridge.',
  gptIds: ['arcanos-research', 'research'],
  defaultTimeoutMs: DEFAULT_RESEARCH_WORKFLOW_TIMEOUT_MS,
  actions: {
    async run(payload: unknown) {
      const normalized = normalizeResearchModulePayload(payload);
      const signal = getRequestAbortSignal();
      const request = {
        topic: normalized.topic,
        urls: normalized.urls,
        metadata: normalized.metadata,
      };
      return signal
        ? requestResearchViaHub(RESEARCH_MODULE_NAME, request, { signal })
        : requestResearchViaHub(RESEARCH_MODULE_NAME, request);
    }
  }
};

export default ArcanosResearch;
