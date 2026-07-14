import { describe, expect, it } from '@jest/globals';

import { createAuditSummary } from '../src/services/auditSafe.js';

describe('audit summary redaction', () => {
  it('redacts secret-shaped provider output before it can be persisted', () => {
    const syntheticSecret = `sk-${'a'.repeat(24)}`;

    expect(createAuditSummary(`Provider returned ${syntheticSecret}`)).toBe('[REDACTED]');
  });
});
