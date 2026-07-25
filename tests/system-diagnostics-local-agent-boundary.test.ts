import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getLatestJobMock = jest.fn();
const queryMock = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  getLatestJob: getLatestJobMock,
  getStatus: jest.fn(() => ({
    connected: true,
    hasPool: true,
    error: null
  })),
  query: queryMock
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: jest.fn(() => ({
    mode: 'test',
    started: false
  }))
}));

const {
  generateSystemDiagnostics,
  formatDiagnosticsAsYAML
} = await import('../src/platform/logging/systemDiagnostics.js');

describe('public system diagnostics local-agent boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('omits local-agent jobs even if an upstream latest-job source returns one', async () => {
    getLatestJobMock.mockResolvedValue({
      id: 'local-agent-job-secret',
      worker_id: 'preview-device',
      job_type: 'local-agent',
      status: 'completed',
      input: { patch: 'private patch material' },
      output: { diff: 'private repository output' },
      created_at: new Date('2026-07-24T00:00:00.000Z'),
      completed_at: new Date('2026-07-24T00:01:00.000Z')
    });

    const diagnostics = await generateSystemDiagnostics();
    const yaml = formatDiagnosticsAsYAML(diagnostics);

    expect(diagnostics.job_data_entry).toBeUndefined();
    expect(yaml).not.toContain('local-agent-job-secret');
    expect(yaml).not.toContain('private patch material');
    expect(yaml).not.toContain('private repository output');
  });

  it('publishes only bounded metadata for an ordinary latest job', async () => {
    getLatestJobMock.mockResolvedValue({
      id: 'ordinary-job',
      worker_id: 'worker-1',
      job_type: 'ask',
      status: 'completed',
      input: { prompt: 'private prompt material' },
      output: { text: 'private completion material' },
      created_at: new Date('2026-07-24T00:00:00.000Z'),
      completed_at: new Date('2026-07-24T00:01:00.000Z')
    });

    const diagnostics = await generateSystemDiagnostics();
    const yaml = formatDiagnosticsAsYAML(diagnostics);

    expect(diagnostics.job_data_entry).toEqual({
      id: 'ordinary-job',
      worker_id: 'worker-1',
      job_type: 'ask',
      status: 'completed',
      created_at: '2026-07-24T00:00:00.000Z',
      completed_at: '2026-07-24T00:01:00.000Z'
    });
    expect(yaml).not.toContain('private prompt material');
    expect(yaml).not.toContain('private completion material');
  });
});
