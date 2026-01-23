import { generateRequestId } from '../../utils/idGenerator.js';
import { MOCK_RESPONSE_CONSTANTS, MOCK_RESPONSE_MESSAGES, truncateInput } from '../../config/mockResponseConfig.js';

/**
 * Mock response structure for OpenAI API calls
 * @confidence 1.0 - Well-defined mock structure
 */
export interface MockResponse {
  meta: {
    id: string;
    created: number;
    tokens: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  activeModel: string;
  fallbackFlag: boolean;
  gpt5Used: boolean;
  routingStages: string[];
  auditSafe: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage: {
    requestId: string;
    logged: boolean;
  };
  error: string;
  result?: string;
  componentStatus?: string;
  suggestedFixes?: string;
  coreLogicTrace?: string;
  gpt5Delegation?: {
    used: boolean;
    reason: string;
    delegatedQuery: string;
  };
  module?: string;
  endpoint?: string;
}

/**
 * Generate a mock OpenAI response for testing/fallback scenarios
 * @confidence 1.0 - Type-safe mock response generation
 */
export const generateMockResponse = (input: string, endpoint: string = 'ask'): MockResponse => {
  const mockId = generateRequestId('mock');
  const timestamp = Math.floor(Date.now() / 1000);
  const inputPreview = truncateInput(input);

  const baseMockResponse = {
    meta: {
      id: mockId,
      created: timestamp,
      tokens: {
        prompt_tokens: MOCK_RESPONSE_CONSTANTS.PROMPT_TOKENS,
        completion_tokens: MOCK_RESPONSE_CONSTANTS.COMPLETION_TOKENS,
        total_tokens: MOCK_RESPONSE_CONSTANTS.TOTAL_TOKENS
      }
    },
    activeModel: MOCK_RESPONSE_CONSTANTS.MODEL_NAME,
    fallbackFlag: false,
    gpt5Used: true,
    routingStages: [...MOCK_RESPONSE_CONSTANTS.ROUTING_STAGES],
    auditSafe: {
      mode: true,
      overrideUsed: input.toLowerCase().includes('override'),
      overrideReason: input.toLowerCase().includes('override')
        ? MOCK_RESPONSE_MESSAGES.OVERRIDE_DETECTED
        : undefined,
      auditFlags: [...MOCK_RESPONSE_CONSTANTS.AUDIT_FLAGS],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: Math.floor(Math.random() * MOCK_RESPONSE_CONSTANTS.MAX_MEMORY_ENTRIES),
      contextSummary: MOCK_RESPONSE_MESSAGES.MEMORY_CONTEXT,
      memoryEnhanced: Math.random() > MOCK_RESPONSE_CONSTANTS.MEMORY_ENHANCEMENT_PROBABILITY
    },
    taskLineage: {
      requestId: mockId,
      logged: true
    },
    error: MOCK_RESPONSE_MESSAGES.NO_API_KEY
  };

  switch (endpoint) {
    case 'arcanos':
      return {
        ...baseMockResponse,
        result: `[MOCK ARCANOS RESPONSE] System analysis for: "${inputPreview}"`,
        componentStatus: MOCK_RESPONSE_MESSAGES.ALL_SYSTEMS_OPERATIONAL,
        suggestedFixes: MOCK_RESPONSE_MESSAGES.CONFIGURE_API_KEY,
        coreLogicTrace: MOCK_RESPONSE_MESSAGES.CORE_LOGIC_TRACE,
        gpt5Delegation: {
          used: true,
          reason: MOCK_RESPONSE_MESSAGES.GPT5_ROUTING,
          delegatedQuery: input
        }
      };
    case 'ask':
    case 'brain':
      return {
        ...baseMockResponse,
        result: `[MOCK AI RESPONSE] Processed request: "${inputPreview}"`,
        module: 'MockBrain'
      };
    case 'write':
      return {
        ...baseMockResponse,
        result: `[MOCK WRITE RESPONSE] Generated content for: "${inputPreview}"`,
        module: 'MockWriter',
        endpoint: 'write'
      };
    case 'guide':
      return {
        ...baseMockResponse,
        result: `[MOCK GUIDE RESPONSE] Step-by-step guidance for: "${inputPreview}"`,
        module: 'MockGuide',
        endpoint: 'guide'
      };
    case 'audit':
      return {
        ...baseMockResponse,
        result: `[MOCK AUDIT RESPONSE] Analysis and evaluation of: "${inputPreview}"`,
        module: 'MockAuditor',
        endpoint: 'audit'
      };
    case 'sim':
      return {
        ...baseMockResponse,
        result: `[MOCK SIMULATION RESPONSE] Scenario modeling for: "${inputPreview}"`,
        module: 'MockSimulator',
        endpoint: 'sim'
      };
    default:
      return {
        ...baseMockResponse,
        result: `[MOCK RESPONSE] Processed request: "${inputPreview}"`,
        module: 'MockProcessor'
      };
  }
};

