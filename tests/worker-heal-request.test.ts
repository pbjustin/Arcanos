import { describe, expect, it } from '@jest/globals';
import { parseWorkerHealRequest } from '../src/shared/http/workerHealRequest.js';

describe('parseWorkerHealRequest', () => {
  it('supports plan-mode requests through the query string', () => {
    const parsed = parseWorkerHealRequest(undefined, { mode: 'plan', force: 'false' });

    expect(parsed).toEqual({
      success: true,
      data: {
        force: false,
        execute: false,
        mode: 'plan',
        planOnlyRequested: true,
        requestedExecution: false
      }
    });
  });

  it('supports execute requests through the JSON body', () => {
    const parsed = parseWorkerHealRequest({ execute: true, force: true }, undefined);

    expect(parsed).toEqual({
      success: true,
      data: {
        force: true,
        execute: true,
        mode: 'execute',
        planOnlyRequested: false,
        requestedExecution: true
      }
    });
  });

  it('rejects conflicting plan and execute flags', () => {
    const parsed = parseWorkerHealRequest({ mode: 'plan', execute: true }, undefined);

    expect(parsed).toEqual({
      success: false,
      issues: ['mode=plan conflicts with execute=true.']
    });
  });
});
