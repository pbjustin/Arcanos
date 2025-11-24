/**
 * Prompt Management System
 * Loads prompts from JSON configuration and provides typed access
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../utils/structuredLogging.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PromptsConfig {
  backstage: {
    booker_persona: string;
    response_guidelines: string;
    instructions_suffix: string;
  };
  arcanos: {
    intake_system: string;
    gpt5_reasoning: string;
    fallback_mode: string;
    system_prompt: string;
    secure_reasoning_integration: string;
    user_prompt: string;
  };
  system: {
    routing_active: string;
    helpful_assistant: string;
    precise_assistant: string;
  };
  research: {
    synthesizer_prompt: string;
  };
  reasoning: {
    layer_system: string;
    enhancement_prompt: string;
  };
  security: {
    reasoning_engine_prompt: string;
    structured_response_template: string;
  };
  gaming: {
    hotline_system: string;
    web_uncertainty_guidance: string;
    web_context_instruction: string;
  };
}

let promptsConfig: PromptsConfig | null = null;

const CONFIG_SEARCH_PATHS = [
  join(process.cwd(), 'config', 'prompts.json'),
  join(__dirname, 'prompts.json'),
  join(process.cwd(), 'src', 'config', 'prompts.json')
];

function resolvePromptsConfigPath(): string | null {
  for (const candidatePath of CONFIG_SEARCH_PATHS) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

/**
 * Load prompts configuration from JSON file
 */
function loadPromptsConfig(): PromptsConfig {
  if (promptsConfig) {
    return promptsConfig;
  }

  try {
    const configPath = resolvePromptsConfigPath();

    if (!configPath) {
      throw new Error('Prompts configuration file not found in expected locations');
    }

    const configData = readFileSync(configPath, 'utf-8');
    promptsConfig = JSON.parse(configData);

    logger.info('Loaded prompts configuration', {
      module: 'prompts',
      operation: 'loadConfig',
      sectionsLoaded: promptsConfig ? Object.keys(promptsConfig).length : 0,
      configPath
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return promptsConfig!;
  } catch (error) {
    logger.error('Failed to load prompts configuration', {
      module: 'prompts',
      operation: 'loadConfig',
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    // Return fallback configuration
    return {
      backstage: {
        booker_persona: 'You are a professional wrestling booker.',
        response_guidelines: 'Provide structured booking decisions.',
        instructions_suffix: ''
      },
      arcanos: {
        intake_system: 'You are ARCANOS AI system.',
        gpt5_reasoning: 'Use reasoning for analysis.',
        fallback_mode: 'System temporarily unavailable.',
        system_prompt: 'You are ARCANOS AI system.',
        secure_reasoning_integration: '[SECURE REASONING INTEGRATION]',
        user_prompt: 'You are ARCANOS.'
      },
      system: {
        routing_active: 'ARCANOS routing active',
        helpful_assistant: 'You are a helpful AI assistant.',
        precise_assistant: 'You are a precise assistant.'
      },
      research: {
        synthesizer_prompt: 'Research and synthesize information.'
      },
      reasoning: {
        layer_system: 'Enhance responses with reasoning.',
        enhancement_prompt: 'Analyze and improve the response.'
      },
      security: {
        reasoning_engine_prompt: 'You are the reasoning engine for ARCANOS.',
        structured_response_template: 'ARCANOS REASONING ENGINE ANALYSIS'
      },
      gaming: {
        hotline_system:
          'You are ARCANOS:GAMING, a Nintendo-style hotline advisor. Provide strategies, hints, tips, and walkthroughs. Speak like a professional hotline guide: friendly, knowledgeable, and interactive.',
        web_uncertainty_guidance:
          'If you are unsure about mechanics, progression steps, or patch-specific details, ask for a guide URL so the ARCANOS web fetcher can pull the latest info instead of guessing.',
        web_context_instruction:
          'Use the sources above to keep recommendations current. If the sources do not mention the requested details, say so and ask for a guide URL to fetch rather than guessing.'
      }
    };
  }
}

// Legacy exports for backward compatibility
export const BACKSTAGE_BOOKER_PERSONA = () => loadPromptsConfig().backstage.booker_persona;
export const BOOKING_RESPONSE_GUIDELINES = () => loadPromptsConfig().backstage.response_guidelines;
export const BOOKING_INSTRUCTIONS_SUFFIX = () => loadPromptsConfig().backstage.instructions_suffix;

/**
 * ARCANOS System Prompts with template support
 */
export const ARCANOS_SYSTEM_PROMPTS = {
  INTAKE: (contextSummary: string) => {
    const template = loadPromptsConfig().arcanos.intake_system;
    return template.replace('{contextSummary}', contextSummary);
  },
  
  GPT5_REASONING: () => loadPromptsConfig().arcanos.gpt5_reasoning,
  
  FALLBACK_MODE: (prompt: string) => {
    const template = loadPromptsConfig().arcanos.fallback_mode;
    const truncatedPrompt = prompt.slice(0, 200);
    return template.replace('{prompt}', truncatedPrompt);
  }
} as const;

/**
 * Get all prompts configuration
 */
export const getPromptsConfig = (): PromptsConfig => loadPromptsConfig();

/**
 * Get prompt by category and key with template support
 */
export const getPrompt = (category: keyof PromptsConfig, key: string, replacements?: Record<string, string>): string => {
  const config = loadPromptsConfig();
  const categoryConfig = config[category] as any;
  
  if (!categoryConfig || !categoryConfig[key]) {
    logger.warn('Prompt not found', {
      module: 'prompts',
      operation: 'getPrompt',
      category,
      key
    });
    return `[Prompt not found: ${category}.${key}]`;
  }

  let prompt = categoryConfig[key];
  
  // Apply replacements if provided
  if (replacements) {
    for (const [placeholder, value] of Object.entries(replacements)) {
      prompt = prompt.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), value);
    }
  }

  return prompt;
};

/**
 * Helper functions for ARCANOS prompts
 */
export const getArcanosSystemPrompt = (): string => {
  return loadPromptsConfig().arcanos.system_prompt;
};

export const getArcanosUserPrompt = (userInput: string, memoryContext?: string): string => {
  const template = loadPromptsConfig().arcanos.user_prompt;
  const memorySection = memoryContext 
    ? `\n[MEMORY CONTEXT INTEGRATION]\n${memoryContext}\nApply relevant memory context to maintain continuity in your response.`
    : '';
  
  return template
    .replace('{memoryContext}', memorySection)
    .replace('{userInput}', userInput);
};

export const getSecureReasoningIntegrationPrompt = (
  userInput: string,
  reason: string,
  complianceStatus: string,
  structuredAnalysis: string,
  problemSolvingSteps: string,
  recommendations: string
): string => {
  const template = loadPromptsConfig().arcanos.secure_reasoning_integration;
  return template
    .replace('{userInput}', userInput)
    .replace('{reason}', reason)
    .replace('{complianceStatus}', complianceStatus)
    .replace('{structuredAnalysis}', structuredAnalysis)
    .replace('{problemSolvingSteps}', problemSolvingSteps)
    .replace('{recommendations}', recommendations);
};

export const getSecurityReasoningEnginePrompt = (userInput: string): string => {
  const template = loadPromptsConfig().security.reasoning_engine_prompt;
  return template.replace('{userInput}', userInput);
};

export const getStructuredSecurityResponseTemplate = (
  inputSummary: string,
  content: string,
  complianceStatus: string,
  redactionsApplied: string
): string => {
  const template = loadPromptsConfig().security.structured_response_template;
  return template
    .replace('{inputSummary}', inputSummary)
    .replace('{content}', content)
    .replace('{complianceStatus}', complianceStatus)
    .replace('{redactionsApplied}', redactionsApplied);
};
