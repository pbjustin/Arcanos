/**
 * Tests for cognitive domain detection and classification
 */

import { detectCognitiveDomain } from '../src/dispatcher/detectCognitiveDomain.js';
import { gptFallbackClassifier } from '../src/dispatcher/gptDomainClassifier.js';
import type OpenAI from 'openai';

describe('detectCognitiveDomain - heuristic classifier', () => {
  describe('creative domain detection', () => {
    it('detects "write a story" as creative with high confidence', () => {
      const result = detectCognitiveDomain('write a story about dragons');
      expect(result.domain).toBe('creative');
      expect(result.confidence).toBe(0.95);
    });

    it('detects "write story" (without article) as creative', () => {
      const result = detectCognitiveDomain('write story about adventure');
      expect(result.domain).toBe('creative');
      expect(result.confidence).toBe(0.95);
    });

    it('detects "write an epic" as creative', () => {
      const result = detectCognitiveDomain('write an epic poem');
      expect(result.domain).toBe('creative');
      expect(result.confidence).toBe(0.95);
    });

    it('detects various creative content types', () => {
      const prompts = [
        'write a novel about space',
        'write a scene with dialogue',
        'write a poem for my friend',
        'write some lyrics for a song'
      ];
      
      prompts.forEach(prompt => {
        const result = detectCognitiveDomain(prompt);
        expect(result.domain).toBe('creative');
        expect(result.confidence).toBe(0.95);
      });
    });

    it('requires word boundaries - does not match partial words', () => {
      const result = detectCognitiveDomain('rewrite astory document');
      expect(result.domain).not.toBe('creative');
    });
  });

  describe('code domain detection', () => {
    it('detects code-related keywords with high confidence', () => {
      const prompts = [
        'refactor this function',
        'implement authentication',
        'write a function to parse JSON',
        'fix the code in main.ts',
        'review this typescript module',
        'debug this javascript error',
        'write python unit tests'
      ];
      
      prompts.forEach(prompt => {
        const result = detectCognitiveDomain(prompt);
        expect(result.domain).toBe('code');
        expect(result.confidence).toBe(0.9);
      });
    });

    it('requires word boundaries for language names', () => {
      // Should not match "typescript" within another word
      const result = detectCognitiveDomain('discuss typescripts history');
      expect(result.domain).not.toBe('code');
    });
  });

  describe('diagnostic domain detection', () => {
    it('detects debugging and troubleshooting requests', () => {
      const prompts = [
        'diagnose the connection error',
        'debug this race condition',
        'why is my server crashing',
        'review architecture for scalability',
        'audit the security model',
        'analyze this stack trace',
        'investigate this exception'
      ];
      
      prompts.forEach(prompt => {
        const result = detectCognitiveDomain(prompt);
        expect(result.domain).toBe('diagnostic');
        expect(result.confidence).toBe(0.9);
      });
    });
  });

  describe('execution domain detection', () => {
    it('detects execution commands with word boundaries', () => {
      const prompts = [
        'execute the deploy script',
        'run the tests',
        'delete file old.txt',
        'create file new.txt',
        'modify file config.json',
        'deploy to production',
        'restart the service'
      ];
      
      prompts.forEach(prompt => {
        const result = detectCognitiveDomain(prompt);
        expect(result.domain).toBe('execution');
        expect(result.confidence).toBe(0.85);
      });
    });

    it('matches execution commands with punctuation boundaries', () => {
      // Test flexible boundary matching (not just \b)
      const result = detectCognitiveDomain('(execute the script)');
      expect(result.domain).toBe('execution');
      expect(result.confidence).toBe(0.85);
    });

    it('matches execution commands at start of string', () => {
      const result = detectCognitiveDomain('execute now');
      expect(result.domain).toBe('execution');
      expect(result.confidence).toBe(0.85);
    });

    it('matches execution commands at end of string', () => {
      const result = detectCognitiveDomain('please execute');
      expect(result.domain).toBe('execution');
      expect(result.confidence).toBe(0.85);
    });
  });

  describe('natural domain (default)', () => {
    it('returns natural domain with lower confidence for general queries', () => {
      const prompts = [
        'what is the weather today',
        'explain quantum mechanics',
        'tell me about ancient Rome',
        'how does photosynthesis work'
      ];
      
      prompts.forEach(prompt => {
        const result = detectCognitiveDomain(prompt);
        expect(result.domain).toBe('natural');
        expect(result.confidence).toBe(0.6);
      });
    });

    it('returns natural domain when no patterns match', () => {
      const result = detectCognitiveDomain('random unclassifiable text xyz123');
      expect(result.domain).toBe('natural');
      expect(result.confidence).toBe(0.6);
    });
  });

  describe('case insensitivity', () => {
    it('detects domains regardless of case', () => {
      const testCases = [
        { prompt: 'WRITE A STORY', expected: 'creative' },
        { prompt: 'Refactor This Code', expected: 'code' },
        { prompt: 'DEBUG THE ERROR', expected: 'diagnostic' },
        { prompt: 'EXECUTE NOW', expected: 'execution' }
      ];
      
      testCases.forEach(({ prompt, expected }) => {
        const result = detectCognitiveDomain(prompt);
        expect(result.domain).toBe(expected);
      });
    });
  });
});

describe('gptFallbackClassifier - GPT-based classification', () => {
  let mockOpenAI: jest.Mocked<OpenAI>;

  beforeEach(() => {
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn()
        }
      }
    } as any;
  });

  it('returns valid domain from GPT response', async () => {
    (mockOpenAI.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [{ message: { content: 'code' } }]
    });

    const result = await gptFallbackClassifier(mockOpenAI, 'some prompt');
    expect(result).toBe('code');
  });

  it('returns "natural" for invalid domain labels with warning', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    
    (mockOpenAI.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [{ message: { content: 'invalid_domain' } }]
    });

    const result = await gptFallbackClassifier(mockOpenAI, 'some prompt');
    expect(result).toBe('natural');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid domain label'),
      'invalid_domain'
    );
    
    consoleWarnSpy.mockRestore();
  });

  it('returns "natural" for empty GPT response with warning', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    
    (mockOpenAI.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [{ message: { content: '' } }]
    });

    const result = await gptFallbackClassifier(mockOpenAI, 'some prompt');
    expect(result).toBe('natural');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid domain label'),
      '<empty>'
    );
    
    consoleWarnSpy.mockRestore();
  });

  it('handles case-insensitive domain labels', async () => {
    (mockOpenAI.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [{ message: { content: 'CREATIVE' } }]
    });

    const result = await gptFallbackClassifier(mockOpenAI, 'some prompt');
    expect(result).toBe('creative');
  });

  it('truncates long prompts at semantic boundaries', async () => {
    (mockOpenAI.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [{ message: { content: 'natural' } }]
    });

    // Create a prompt longer than MAX_CLASSIFIER_INPUT_LENGTH (500)
    const longPrompt = 'This is a test sentence. '.repeat(30); // ~750 chars
    await gptFallbackClassifier(mockOpenAI, longPrompt);

    const callArgs = (mockOpenAI.chat.completions.create as jest.Mock).mock.calls[0][0];
    const sentPrompt = callArgs.messages[1].content;
    
    // Should be truncated
    expect(sentPrompt.length).toBeLessThanOrEqual(500);
    // Should not end mid-word (should have smart truncation)
    expect(sentPrompt).toMatch(/[\s.]$/);
  });

  it('preserves short prompts without truncation', async () => {
    (mockOpenAI.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [{ message: { content: 'natural' } }]
    });

    const shortPrompt = 'Short prompt';
    await gptFallbackClassifier(mockOpenAI, shortPrompt);

    const callArgs = (mockOpenAI.chat.completions.create as jest.Mock).mock.calls[0][0];
    const sentPrompt = callArgs.messages[1].content;
    
    expect(sentPrompt).toBe(shortPrompt);
  });

  it('uses correct GPT model and parameters', async () => {
    (mockOpenAI.chat.completions.create as jest.Mock).mockResolvedValue({
      choices: [{ message: { content: 'natural' } }]
    });

    await gptFallbackClassifier(mockOpenAI, 'test prompt');

    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 10,
      messages: expect.any(Array)
    });
  });
});

describe('hybrid classification workflow', () => {
  it('should trigger GPT fallback when heuristic confidence is < 0.85', () => {
    // Natural domain returns 0.6 confidence, which is < 0.85
    const result = detectCognitiveDomain('what is the meaning of life');
    expect(result.confidence).toBe(0.6);
    expect(result.confidence).toBeLessThan(0.85);
    // In the actual implementation, this would trigger GPT fallback
  });

  it('should NOT trigger GPT fallback when heuristic confidence is >= 0.85', () => {
    // Creative domain returns 0.95 confidence, which is >= 0.85
    const result = detectCognitiveDomain('write a story');
    expect(result.confidence).toBe(0.95);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    // In the actual implementation, this would NOT trigger GPT fallback
  });

  it('execution domain (0.85) exactly meets the threshold', () => {
    const result = detectCognitiveDomain('execute the script');
    expect(result.confidence).toBe(0.85);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    // Should NOT trigger GPT fallback (>= check)
  });
});
