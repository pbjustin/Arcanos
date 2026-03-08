import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const originalDatabaseUrl = process.env.DATABASE_URL;
const mockDotenvConfig = jest.fn(() => {
  process.env.DATABASE_URL = 'postgresql://dotenv.example/arcanos';
  return {
    parsed: {
      DATABASE_URL: process.env.DATABASE_URL
    }
  };
});

jest.unstable_mockModule('dotenv', () => ({
  __esModule: true,
  default: {
    config: mockDotenvConfig
  }
}));

describe('runtime env bootstrap', () => {
  beforeEach(() => {
    jest.resetModules();
    mockDotenvConfig.mockClear();
    delete process.env.DATABASE_URL;
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
      return;
    }

    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('loads dotenv before serving runtime env reads', async () => {
    const { getEnv } = await import('../src/platform/runtime/env.js');

    expect(mockDotenvConfig).toHaveBeenCalledTimes(1);
    expect(getEnv('DATABASE_URL')).toBe('postgresql://dotenv.example/arcanos');
  });
});
