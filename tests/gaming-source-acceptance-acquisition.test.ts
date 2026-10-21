import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
const resolve4 = jest.fn(async () => ['93.184.216.34']);
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  resolve4 = resolve4;
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const actor = { actorKey: 'synthetic-acceptance-reader' };
const candidate = (path: string) => ({ url: `https://guides.example.org/${path}` });

beforeEach(() => {
  http.mockReset();
  resolve4.mockReset().mockResolvedValue(['93.184.216.34']);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('incident acquisition failures through the protected resolver', () => {
  it.each(['Elden Ring', 'Fallout 76'])('keeps 403, timeout and exhausted budget distinct for %s', async game => {
    // Synthetic transport only: the real resolver, deadline and candidate classifier run.
    let time = Date.parse('2026-10-13T12:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => time);
    http.mockResolvedValueOnce({ status: 403, headers: { 'content-type': 'text/plain' },
      data: 'Synthetic denied response; never evidence.' });
    http.mockImplementationOnce(async () => {
      time += 5_001;
      const data = Object.assign(Readable.from(['<article>Too late.</article>']), {
        rawHeaders: ['content-type', 'text/html']
      });
      // Match the transport's stream error owner when the deadline disposes the body.
      data.on('error', () => undefined);
      return { status: 200, headers: { 'content-type': 'text/html' }, data };
    });
    const result = await evaluateGamingHybridCandidates({ game, mode: 'build',
      prompt: 'Explain a beginner build immediately after the tutorial.', protocolVersion: 'gaming-hybrid-v2',
      candidates: [candidate('denied'), candidate('timeout'), candidate('unattempted')] },
    { ...actor, maxElapsedMs: 5_000 });
    expect(result.decisions.map(item => item.reasonCodes)).toEqual([
      ['SOURCE_INACCESSIBLE'], ['SOURCE_TIMEOUT'], ['FETCH_BUDGET_EXHAUSTED']
    ]);
    expect(result.evaluations[0].stages.acquisition.diagnostic).toEqual({ httpStatus: 403, acquisitionStage: 'transport', failureClass: 'source_access' });
    expect(result.evaluations.every(item => item.stages.acquisition.status === 'rejected')).toBe(true);
    expect(result.evaluations.every(item => ['extraction', 'identity', 'applicability', 'selection', 'generation']
      .every(stage => item.stages[stage as keyof typeof item.stages].status === 'not_run'))).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.knowledge.sources).toEqual([]);
    expect(http).toHaveBeenCalledTimes(2);
    expect(resolve4).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.evaluations)).not.toMatch(/Synthetic denied|Too late/);
  });

  it.each(['https://127.0.0.1/guide', 'http://guides.example.org/guide'])('blocks unsafe initial URL %s before transport', async url => {
    const result = await evaluateGamingHybridCandidates({ game: 'Fallout 76', mode: 'build',
      prompt: 'Explain a beginner Heavy Gunner build.', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] }, actor);
    expect(result.decisions[0].reasonCodes).toEqual(['URL_BLOCKED']);
    expect(result.accepted).toEqual([]);
    expect(http).not.toHaveBeenCalled();
    expect(resolve4).not.toHaveBeenCalled();
  });

  it.each([
    ['https://127.0.0.1/guide', 'URL_BLOCKED'],
    ['https://unapproved.example.org/guide', 'REDIRECT_NOT_ALLOWED']
  ])('rejects unsafe redirect %s without acquiring its destination', async (location, reason) => {
    http.mockResolvedValue({ status: 302, headers: { location }, data: '' });
    const result = await evaluateGamingHybridCandidates({ game: 'Elden Ring', mode: 'build',
      prompt: 'Explain a beginner Samurai build.', protocolVersion: 'gaming-hybrid-v2', candidates: [candidate('redirect')] }, actor);
    expect(result.decisions[0].reasonCodes).toEqual([reason]);
    expect(result.accepted).toEqual([]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(resolve4).toHaveBeenCalledTimes(1);
    expect(result.evaluations[0].stages.identity.status).toBe('not_run');
  });

  it('rejects DNS rebinding on a same-origin redirect before the second connection', async () => {
    resolve4.mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['127.0.0.1']);
    http.mockResolvedValue({ status: 302, headers: { location: '/next' }, data: '' });
    const result = await evaluateGamingHybridCandidates({ game: 'Fallout 76', mode: 'build',
      prompt: 'Explain a beginner Heavy Gunner build.', protocolVersion: 'gaming-hybrid-v2', candidates: [candidate('redirect')] }, actor);
    expect(result.decisions[0].reasonCodes).toEqual(['URL_BLOCKED']);
    expect(result.accepted).toEqual([]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(resolve4).toHaveBeenCalledTimes(2);
  });
});
