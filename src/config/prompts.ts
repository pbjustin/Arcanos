/**
 * Prompt Management System
 * Loads prompts from JSON configuration and provides typed access
 */

import { readFileSync } from 'fs';
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
}

let promptsConfig: PromptsConfig | null = null;

/**
 * Load prompts configuration from JSON file
 */
function loadPromptsConfig(): PromptsConfig {
  if (promptsConfig) {
    return promptsConfig;
  }

  try {
    const configPath = join(__dirname, 'prompts.json');
    const configData = readFileSync(configPath, 'utf-8');
    promptsConfig = JSON.parse(configData);
    
    logger.info('Loaded prompts configuration', {
      module: 'prompts',
      operation: 'loadConfig',
      sectionsLoaded: promptsConfig ? Object.keys(promptsConfig).length : 0
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
        fallback_mode: 'System temporarily unavailable.'
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
