import {
  buildBackstageBookerManagedAsyncResultPath,
  projectBackstageBookerManagedJobResultPayload,
  projectBackstageBookerManagedPendingResponse,
} from '../src/shared/backstage/backstageBookerAsyncContinuation.js';
import { buildGptJobResultLookupPayload } from '../src/shared/gpt/gptJobResult.js';

describe('Backstage Booker managed-bearer async continuation', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const managedPoll =
    '/gpt-access/capabilities/v1/backstage-booker/jobs/'
    + `${jobId}/result`;

  it('projects every accepted-response link onto the managed bearer operation', () => {
    const genericResponse = {
      ok: true,
      jobId,
      status: 'timeout',
      poll: `/jobs/${jobId}/result`,
      stream: `/jobs/${jobId}/stream`,
      jobReadToken: `v1.${'a'.repeat(43)}`,
      jobReadTokenHeader: 'x-arcanos-job-read-token',
      instruction: `Use GET /jobs/${jobId}/result.`,
      directReturn: {
        requested: true,
        poll: `/jobs/${jobId}/result`,
        result: `/jobs/${jobId}/result`,
      },
    };

    const projected = projectBackstageBookerManagedPendingResponse(
      genericResponse
    );

    expect(projected).toMatchObject({
      ok: true,
      jobId,
      poll: managedPoll,
      instruction: expect.stringContaining('getBackstageBookerJobResult'),
      directReturn: {
        requested: true,
        poll: managedPoll,
        result: managedPoll,
      },
    });
    expect(projected).not.toHaveProperty('stream');
    expect(projected).not.toHaveProperty('jobReadToken');
    expect(projected).not.toHaveProperty('jobReadTokenHeader');
    expect(genericResponse).toHaveProperty('jobReadToken');
    expect(genericResponse.poll).toBe(`/jobs/${jobId}/result`);
  });

  it('keeps not-found result polling on the same managed bearer operation', () => {
    const genericLookup = buildGptJobResultLookupPayload(jobId, null);
    const projected = projectBackstageBookerManagedJobResultPayload(
      genericLookup
    );

    expect(projected).toMatchObject({
      jobId,
      status: 'not_found',
      poll: managedPoll,
    });
    expect(projected).not.toHaveProperty('stream');
    expect(genericLookup.stream).toBe(`/jobs/${jobId}/stream`);
    expect(buildBackstageBookerManagedAsyncResultPath(jobId)).toBe(managedPoll);
  });
});
