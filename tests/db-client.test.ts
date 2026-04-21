import { describe, expect, it } from '@jest/globals';

import { resolveDatabaseConnectionCandidates } from '../src/core/db/client.js';

describe('resolveDatabaseConnectionCandidates', () => {
  it('de-duplicates private Railway URLs while preserving the public fallback', () => {
    const privateUrl = 'postgresql://user:pass@postgres.railway.internal:5432/railway?sslmode=no-verify';
    const publicUrl = 'postgresql://user:pass@roundhouse.proxy.rlwy.net:56689/railway?sslmode=no-verify';

    const candidates = resolveDatabaseConnectionCandidates({
      DATABASE_PRIVATE_URL: privateUrl,
      DATABASE_URL: privateUrl,
      DATABASE_PUBLIC_URL: publicUrl
    } as NodeJS.ProcessEnv);

    expect(candidates.map(candidate => candidate.source)).toEqual([
      'database_private_url',
      'database_public_url'
    ]);
    expect(candidates).toHaveLength(2);
  });
});
