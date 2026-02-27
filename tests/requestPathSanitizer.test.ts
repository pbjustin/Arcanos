import { describe, expect, it } from '@jest/globals';
import { resolveSafeRequestPath, sanitizeRequestPath } from '../src/shared/requestPathSanitizer.js';

describe('requestPathSanitizer', () => {
  it('removes query parameters from raw paths', () => {
    expect(sanitizeRequestPath('/api/run?queryValue=alpha&user=abc')).toBe('/api/run');
  });

  it('prefers request.path when available', () => {
    expect(resolveSafeRequestPath({ path: '/api/status', originalUrl: '/api/status?queryValue=alpha' })).toBe('/api/status');
  });

  it('falls back to sanitized originalUrl when path is missing', () => {
    expect(resolveSafeRequestPath({ originalUrl: '/api/status?queryValue=alpha' })).toBe('/api/status');
  });

  it('returns root slash for empty or query-only values', () => {
    expect(sanitizeRequestPath('?queryValue=alpha')).toBe('/');
    expect(resolveSafeRequestPath({ path: '   ', originalUrl: '   ' })).toBe('/');
  });
});
