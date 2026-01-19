/**
 * Test for the refactored prompts system
 */

import { describe, test, expect } from '@jest/globals';
import { 
  BACKSTAGE_BOOKER_PERSONA, 
  BOOKING_RESPONSE_GUIDELINES,
  BOOKING_INSTRUCTIONS_SUFFIX,
  ARCANOS_SYSTEM_PROMPTS,
  getPrompt,
  getPromptsConfig
} from '../src/config/prompts.js';

describe('Prompts System', () => {
  test('should load backstage prompts correctly', () => {
    const persona = BACKSTAGE_BOOKER_PERSONA();
    const guidelines = BOOKING_RESPONSE_GUIDELINES();
    const suffix = BOOKING_INSTRUCTIONS_SUFFIX();

    expect(persona).toContain('Kay "Spotlight" Morales');
    expect(guidelines).toContain('creative team');
    expect(suffix).toContain('Focus on immersive');
  });

  test('should handle ARCANOS system prompts with templates', () => {
    const intake = ARCANOS_SYSTEM_PROMPTS.INTAKE('Test memory context');
    const reasoning = ARCANOS_SYSTEM_PROMPTS.GPT5_REASONING();
    const fallback = ARCANOS_SYSTEM_PROMPTS.FALLBACK_MODE('Test prompt');

    expect(intake).toContain('Test memory context');
    expect(reasoning).toContain('reasoning');
    expect(fallback).toContain('Test prompt');
  });

  test('should provide generic prompt access', () => {
    const config = getPromptsConfig();
    expect(config).toHaveProperty('backstage');
    expect(config).toHaveProperty('arcanos');
    expect(config).toHaveProperty('system');

    const systemPrompt = getPrompt('system', 'routing_active');
    expect(systemPrompt).toContain('ARCANOS routing active');
  });

  test('should handle template replacements', () => {
    const prompt = getPrompt('reasoning', 'enhancement_prompt', {
      originalPrompt: 'Test original',
      arcanosResult: 'Test result',
      context: 'Test context'
    });

    expect(prompt).toContain('Test original');
    expect(prompt).toContain('Test result');
    expect(prompt).toContain('Test context');
  });

  test('should handle missing prompts gracefully', () => {
    const missing = getPrompt('nonexistent' as any, 'missing');
    expect(missing).toContain('[Prompt not found:');
  });
});