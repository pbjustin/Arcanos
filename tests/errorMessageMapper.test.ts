import { describe, it, expect } from '@jest/globals';
import { mapErrorToFriendlyMessage } from '../src/utils/errorMessageMapper.js';
import { ARCANOS_ERROR_MESSAGES } from '../src/config/errorMessages.js';

describe('mapErrorToFriendlyMessage', () => {
  it('maps connection refused errors to configured message', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1');
    const mapped = mapErrorToFriendlyMessage(error);

    expect(mapped).toBe(ARCANOS_ERROR_MESSAGES.connectionRefused);
  });

  it('returns null when no mapping exists', () => {
    const mapped = mapErrorToFriendlyMessage(new Error('unexpected failure'));
    expect(mapped).toBeNull();
  });
});
