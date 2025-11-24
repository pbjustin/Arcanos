export const FALLBACK_RESPONSE_MESSAGES = {
  cacheUnavailable: 'Service temporarily unavailable - returning cached response',
  cachedResponsePlaceholder: 'Cached response available',
  degradedMode: 'AI services temporarily unavailable - operating in degraded mode',
  fallbackTestPrompt: 'Test degraded mode functionality',
  fallbackTestMessage: 'Fallback system test - this endpoint simulates degraded mode',
  defaultPrompt: 'No input provided',
  healthCheckPrompt: 'Health check triggered fallback'
} as const;
