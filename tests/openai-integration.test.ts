/**
 * Integration tests for OpenAI SDK compatibility and API integration
 */

import { jest } from '@jest/globals';

describe('OpenAI SDK Integration Tests', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('OpenAI Service Integration', () => {
    it('should have OpenAI SDK v5+ properly integrated', async () => {
      // Import the service
      const { getOpenAIClient } = await import('../src/services/openai.js');
      
      // Test the service is properly exported
      expect(getOpenAIClient).toBeDefined();
      expect(typeof getOpenAIClient).toBe('function');
    });

    it('should handle missing API key gracefully with mock responses', async () => {
      // Ensure no API key is set for this test
      const originalApiKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const { getOpenAIClient, generateMockResponse } = await import('../src/services/openai.js');
        
        // Test client returns null when no API key
        const client = getOpenAIClient();
        expect(client).toBeNull();

        // Test mock response generation
        const mockResponse = generateMockResponse('Test input', 'ask');
        expect(mockResponse).toHaveProperty('meta');
        expect(mockResponse.meta).toHaveProperty('id');
        expect(mockResponse.meta).toHaveProperty('created');
        expect(mockResponse.meta).toHaveProperty('tokens');
        expect(mockResponse).toHaveProperty('activeModel', 'MOCK');
        expect(mockResponse).toHaveProperty('result');
        expect(mockResponse.result).toContain('Test input');
      } finally {
        // Restore original environment
        if (originalApiKey) {
          process.env.OPENAI_API_KEY = originalApiKey;
        }
      }
    });

    it('should prioritize FINETUNED_MODEL_ID over AI_MODEL for Railway compatibility', async () => {
      const originalModels = {
        FINETUNED_MODEL_ID: process.env.FINETUNED_MODEL_ID,
        AI_MODEL: process.env.AI_MODEL
      };

      process.env.FINETUNED_MODEL_ID = 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote';
      process.env.AI_MODEL = 'gpt-3.5-turbo';

      try {
        // Reset modules to get fresh import
        jest.resetModules();
        const { getDefaultModel } = await import('../src/services/openai.js');
        
        const defaultModel = getDefaultModel();
        expect(defaultModel).toBe('ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote');
      } finally {
        // Restore original environment
        Object.entries(originalModels).forEach(([key, value]) => {
          if (value) {
            process.env[key] = value;
          } else {
            delete process.env[key];
          }
        });
      }
    });

    it('should fallback to AI_MODEL when FINETUNED_MODEL_ID is not set', async () => {
      const originalModels = {
        FINETUNED_MODEL_ID: process.env.FINETUNED_MODEL_ID,
        AI_MODEL: process.env.AI_MODEL
      };

      delete process.env.FINETUNED_MODEL_ID;
      process.env.AI_MODEL = 'gpt-3.5-turbo-test';

      try {
        // Reset modules to get fresh import
        jest.resetModules();
        const { getDefaultModel } = await import('../src/services/openai.js');
        
        const defaultModel = getDefaultModel();
        expect(defaultModel).toBe('gpt-3.5-turbo-test');
      } finally {
        // Restore original environment
        Object.entries(originalModels).forEach(([key, value]) => {
          if (value) {
            process.env[key] = value;
          } else {
            delete process.env[key];
          }
        });
      }
    });
  });

  describe('Mock Response Generation', () => {
    it('should generate appropriate mock responses when API is unavailable', async () => {
      // Import the service
      const { generateMockResponse } = await import('../src/services/openai.js');
      
      const mockResponse = generateMockResponse('Test input', 'ask');
      
      expect(mockResponse).toHaveProperty('meta');
      expect(mockResponse.meta).toHaveProperty('id');
      expect(mockResponse.meta).toHaveProperty('created');
      expect(mockResponse.meta).toHaveProperty('tokens');
      expect(mockResponse).toHaveProperty('activeModel', 'MOCK');
      expect(mockResponse).toHaveProperty('result');
      expect(mockResponse.result).toContain('Test input');
    });

    it('should generate different mock responses for different endpoints', async () => {
      // Import the service
      const { generateMockResponse } = await import('../src/services/openai.js');
      
      const askResponse = generateMockResponse('Test input', 'ask');
      const simResponse = generateMockResponse('Test input', 'sim');
      
      expect(askResponse.result).not.toBe(simResponse.result);
      expect(simResponse.result.toLowerCase()).toContain('simulation');
    });

    it('should generate consistent mock structure across different endpoints', async () => {
      // Import the service
      const { generateMockResponse } = await import('../src/services/openai.js');
      
      const endpoints = ['ask', 'sim', 'write', 'guide', 'audit'];
      
      endpoints.forEach(endpoint => {
        const response = generateMockResponse('Test input', endpoint);
        
        // All mock responses should have consistent structure
        expect(response).toHaveProperty('meta');
        expect(response.meta).toHaveProperty('id');
        expect(response.meta).toHaveProperty('created');
        expect(response.meta).toHaveProperty('tokens');
        expect(response).toHaveProperty('activeModel', 'MOCK');
        expect(response).toHaveProperty('result');
        expect(typeof response.result).toBe('string');
      });
    });
  });

  describe('Railway Environment Compatibility', () => {
    it('should support Railway environment variables', async () => {
      const { validateEnvironment } = await import('../src/utils/environmentValidation.js');
      
      // Test environment validation works
      const result = validateEnvironment();
      expect(result).toHaveProperty('isValid');
      expect(typeof result.isValid).toBe('boolean');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result).toHaveProperty('warnings');
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('should handle PORT environment variable for Railway deployment', async () => {
      const originalPort = process.env.PORT;
      process.env.PORT = '3000';

      try {
        const { validateEnvironment } = await import('../src/utils/environmentValidation.js');
        
        const result = validateEnvironment();
        expect(result.isValid).toBe(true);
        expect(process.env.PORT).toBe('3000');
      } finally {
        if (originalPort) {
          process.env.PORT = originalPort;
        } else {
          delete process.env.PORT;
        }
      }
    });
  });

  describe('Circuit Breaker and Error Handling', () => {
    it('should have circuit breaker for API resilience', async () => {
      const { callOpenAI } = await import('../src/services/openai.js');
      
      // Function should exist and be callable
      expect(callOpenAI).toBeDefined();
      expect(typeof callOpenAI).toBe('function');
      
      // Call with mock scenario (no API key)
      const originalApiKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      
      try {
        const result = await callOpenAI('gpt-4', 'Test prompt', 100, false);
        
        // Should return a result even without API key (fallback)
        expect(result).toHaveProperty('response');
        expect(result).toHaveProperty('output');
        expect(typeof result.output).toBe('string');
      } finally {
        if (originalApiKey) {
          process.env.OPENAI_API_KEY = originalApiKey;
        }
      }
    });
  });

  describe('Health Check Integration', () => {
    it('should provide OpenAI service health status', async () => {
      const { getOpenAIServiceHealth } = await import('../src/services/openai.js');
      
      expect(getOpenAIServiceHealth).toBeDefined();
      expect(typeof getOpenAIServiceHealth).toBe('function');
      
      const healthStatus = getOpenAIServiceHealth();
      expect(healthStatus).toHaveProperty('apiKey');
      expect(healthStatus).toHaveProperty('client');
      expect(healthStatus).toHaveProperty('circuitBreaker');
      expect(healthStatus).toHaveProperty('cache');
      expect(healthStatus).toHaveProperty('lastHealthCheck');
      
      // Check API key status
      expect(healthStatus.apiKey).toHaveProperty('configured');
      expect(healthStatus.apiKey).toHaveProperty('status');
      
      // Check client status
      expect(healthStatus.client).toHaveProperty('initialized');
      expect(healthStatus.client).toHaveProperty('model');
      expect(healthStatus.client).toHaveProperty('timeout');
      
      // Check circuit breaker health
      expect(healthStatus.circuitBreaker).toHaveProperty('healthy');
    });
  });
});