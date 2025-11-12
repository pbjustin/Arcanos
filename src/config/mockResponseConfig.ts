/**
 * Mock Response Configuration
 * Constants for mock AI responses when API key is not configured
 */

export const MOCK_RESPONSE_CONSTANTS = {
  // Token counts for mock responses
  PROMPT_TOKENS: 50,
  COMPLETION_TOKENS: 100,
  TOTAL_TOKENS: 150,
  
  // Text truncation
  MAX_INPUT_PREVIEW_LENGTH: 50,
  
  // Mock memory context
  MAX_MEMORY_ENTRIES: 3,
  MEMORY_ENHANCEMENT_PROBABILITY: 0.5,
  
  // Mock model identifier
  MODEL_NAME: 'MOCK',
  
  // Routing stages for mock responses
  ROUTING_STAGES: ['ARCANOS-INTAKE:MOCK', 'GPT5-REASONING', 'ARCANOS-FINAL'],
  
  // Audit flags for mock mode
  AUDIT_FLAGS: ['MOCK_MODE', 'AUDIT_SAFE_ACTIVE']
} as const;

export const MOCK_RESPONSE_MESSAGES = {
  NO_API_KEY: 'OPENAI_API_KEY not configured - returning mock response',
  MEMORY_CONTEXT: 'Mock memory context - no real memory system active',
  OVERRIDE_DETECTED: 'Mock override detected in input',
  
  // Status messages
  ALL_SYSTEMS_OPERATIONAL: 'MOCK: All systems simulated as operational',
  CONFIGURE_API_KEY: 'MOCK: Configure OPENAI_API_KEY for real analysis',
  CORE_LOGIC_TRACE: 'MOCK: Trinity -> ARCANOS -> Mock Response Generator',
  
  // GPT-5 delegation
  GPT5_ROUTING: 'Unconditional GPT-5 routing (mock)'
} as const;

/**
 * Truncates input text for preview display
 * 
 * @param input - Text to truncate
 * @param maxLength - Maximum length before truncation
 * @returns Truncated text with ellipsis if needed
 */
export function truncateInput(input: string, maxLength: number = MOCK_RESPONSE_CONSTANTS.MAX_INPUT_PREVIEW_LENGTH): string {
  return input.length > maxLength ? `${input.substring(0, maxLength)}...` : input;
}
