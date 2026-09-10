import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const mockAxiosGet = jest.fn();
const mockResolve4 = jest.fn();
const mockResolve6 = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockAxiosGet) }));
jest.unstable_mockModule('node:dns/promises', () => ({
  Resolver: class {
    resolve4(host: string) { return mockResolve4(host); }
    resolve6(host: string) { return mockResolve6(host); }
    cancel() {}
  }
}));
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');

describe('shared resolver inert JSON evidence', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockResolve4.mockResolvedValue(['93.184.216.34']);
    mockResolve6.mockResolvedValue([]);
  });

  it('preserves a sparse JSON location as one source-attributable record from one protected response', async () => {
    const body = '{"system":"TEST-ORION-01","body":"B 2","site":"PML 7","resource":"Platinum"}';
    expect(body.length).toBeLessThan(120);
    mockAxiosGet.mockResolvedValue({ data: body, headers: { 'content-type': 'application/json' } });
    const document = await resolveGamingDocument('https://synthetic.example/resource-record');
    expect(document).toMatchObject({
      evidenceUnits: [expect.objectContaining({
        kind: 'structured_record',
        integrity: { status: 'complete', reasons: [] },
        provenance: expect.objectContaining({
          sourceUrl: 'https://synthetic.example/resource-record', strategy: 'application_json', jsonOnly: true
        })
      })]
    });
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });
});
