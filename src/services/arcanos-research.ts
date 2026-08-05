import type { ModuleDef } from './moduleLoader.js';
import {
  normalizeResearchModulePayload,
  RESEARCH_MODULE_NAME,
} from '@shared/researchRequest.js';
import { requestResearchViaHub } from './researchHub.js';

const ArcanosResearch: ModuleDef = {
  name: RESEARCH_MODULE_NAME,
  description: 'Research orchestration module backed by the shared research bridge.',
  gptIds: ['arcanos-research', 'research'],
  defaultTimeoutMs: 60000,
  actions: {
    async run(payload: unknown) {
      const normalized = normalizeResearchModulePayload(payload);
      return requestResearchViaHub(RESEARCH_MODULE_NAME, {
        topic: normalized.topic,
        urls: normalized.urls,
        metadata: normalized.metadata,
      });
    }
  }
};

export default ArcanosResearch;
