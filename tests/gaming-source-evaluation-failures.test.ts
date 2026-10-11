import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; } async resolve6() { return []; } cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const first = 'https://guides.example.org/first';
const second = 'https://guides.example.org/second';
const submission = { game: 'Portal 2', edition: 'base-game', mode: 'guide' as const,
  prompt: 'Explain copper staff timing.', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: first }, { url: second }] };
const body = '<title>Portal 2 copper staff guide</title><article><h1>Portal 2 copper staff guide</h1>'
  + '<p>In Portal 2, this synthetic copper staff timing guide explains how to wait for a safe opening. '
  + 'Copper staff timing uses a short practice cycle and preserves room for movement before the next practice action.</p></article>';

describe('source traces survive interrupted production evaluation', () => {
  it('logs every started source when acquisition cancellation propagates', async () => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: body });
    const controller = new AbortController();
    const logged = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await expect(evaluateGamingHybridCandidates(submission, { actorKey: 'offline-test', signal: controller.signal }, {
        resolveDocument: async (...args) => {
          const doc = await resolveGamingDocument(...args);
          if (args[0] === second) controller.abort();
          return doc;
        }
      })).rejects.toThrow();
      const traces = logged.mock.calls.filter(call => call[0] === 'gaming.source.evaluation').map(call => call[1] as any);
      expect(traces).toHaveLength(2);
      expect(traces.some(trace => trace.rejectionReasons.includes('REQUEST_CANCELLED'))).toBe(true);
      expect(traces.every(trace => trace.stages.generation.status === 'not_run')).toBe(true);
      expect(JSON.stringify(traces)).not.toMatch(/copper|practice|offline-test/);
    } finally { logged.mockRestore(); }
  });

  it('logs completed acquisitions if selection fails without granting recovery', async () => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: body });
    const logged = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await expect(evaluateGamingHybridCandidates(submission, { actorKey: 'offline-test' }, {
        selectEvidence: () => { throw new Error('private exception payload'); }
      })).rejects.toThrow('private exception payload');
      const traces = logged.mock.calls.filter(call => call[0] === 'gaming.source.evaluation').map(call => call[1] as any);
      expect(traces).toHaveLength(2);
      expect(traces.every(trace => trace.stages.acquisition.status === 'passed')).toBe(true);
      expect(traces.every(trace => trace.stages.selection.reasonCode === 'EVIDENCE_SELECTION_FAILED')).toBe(true);
      expect(traces.every(trace => !trace.recovery.eligible)).toBe(true);
      expect(JSON.stringify(traces)).not.toContain('private exception payload');
    } finally { logged.mockRestore(); }
  });
});
