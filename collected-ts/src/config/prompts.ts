/**
 * Prompt Management System
 * Loads prompts from JSON configuration and provides typed access
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../utils/structuredLogging.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { assertProtectedConfigIntegrity } from '../services/safety/configIntegrity.js';

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
    final_original_request_prefix: string;
    final_gpt5_analysis_prefix: string;
    final_response_instruction: string;
    final_review_system: string;
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
    intake_system: string;
    audit_system: string;
    web_uncertainty_guidance: string;
    web_context_instruction: string;
  };
  trinity: TrinityMessages;
}

export type TrinityMessages = {
  dry_run_result_message: string;
  dry_run_no_invocation_reason: string;
  dry_run_reason_placeholder: string;
  pattern_storage_label: string;
  audit_endpoint_name: string;
};

const TRINITY_MESSAGES_DEFAULTS: TrinityMessages = {
  dry_run_result_message: '[Dry run] Trinity pipeline preview generated.',
  dry_run_no_invocation_reason: 'Dry run: no model invocation',
  dry_run_reason_placeholder: 'Dry run reason: not provided.',
  pattern_storage_label: 'Successful Trinity pipeline',
  audit_endpoint_name: 'trinity_gpt5_universal'
};

let promptsConfig: PromptsConfig | null = null;

const CONFIG_SEARCH_PATHS = [
  join(process.cwd(), 'config', 'prompts.json'),
  join(__dirname, 'prompts.json'),
  join(process.cwd(), 'src', 'config', 'prompts.json')
];

const PROMPT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PROMPT_ROLE_OVERRIDE_PATTERN = /(^|\n)\s*(system|developer|assistant)\s*:/gi;
const PROMPT_INJECTION_SENTINELS = ['<|im_start|>', '<|im_end|>', '<|start_header_id|>', '<|end_header_id|>'] as const;

/**
 * Escape regex metacharacters in a string.
 * Inputs/Outputs: raw string -> escaped string safe for RegExp constructors.
 * Edge cases: returns empty string when input is empty.
 */
function escapeRegExpCharacters(rawValue: string): string {
  return rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize potentially untrusted text before embedding into LLM prompts.
 * Inputs/Outputs: untrusted text + optional fallback -> sanitized text.
 * Edge cases: returns fallback when value is null/undefined/blank after trim.
 */
function sanitizeInterpolatedPromptValue(rawValue: string | null | undefined, fallbackValue = ''): string {
  const normalizedValue = typeof rawValue === 'string' ? rawValue.trim() : '';
  //audit Assumption: null/blank input indicates missing content; risk is empty prompt sections that break downstream logic; invariant is non-null string output; handling strategy uses explicit fallback text.
  if (!normalizedValue) {
    return fallbackValue;
  }

  //audit Assumption: ASCII control chars are non-semantic in user text; risk is delimiter/control channel abuse; invariant is printable prompt content; handling strategy strips unsafe control bytes.
  let sanitizedValue = normalizedValue.replace(PROMPT_CONTROL_CHARACTER_PATTERN, ' ');
  //audit Assumption: explicit role labels can be used to override model behavior; risk is role-hijack prompt injection; invariant is role labels are rendered inert; handling strategy rewrites role prefixes.
  sanitizedValue = sanitizedValue.replace(PROMPT_ROLE_OVERRIDE_PATTERN, '$1[neutralized-role]:');
  //audit Assumption: known chat sentinels may be interpreted as control tokens; risk is escaping system boundaries; invariant is sentinel text cannot be interpreted as control markers; handling strategy replaces sentinel occurrences.
  for (const sentinel of PROMPT_INJECTION_SENTINELS) {
    const sentinelPattern = new RegExp(escapeRegExpCharacters(sentinel), 'gi');
    sanitizedValue = sanitizedValue.replace(sentinelPattern, '[neutralized-token]');
  }

  //audit Assumption: XML-style delimiters are used in composed prompts; risk is delimiter breakout via injected angle brackets; invariant is interpolated content cannot close prompt tags; handling strategy encodes angle brackets.
  return sanitizedValue.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace all placeholder token occurrences in a prompt template with sanitized values.
 * Inputs/Outputs: template + token name + untrusted value -> updated template.
 * Edge cases: unchanged template when token is missing.
 */
function replaceTemplateToken(template: string, placeholder: string, rawValue: string | null | undefined, fallbackValue = ''): string {
  const placeholderPattern = new RegExp(`\\{${escapeRegExpCharacters(placeholder)}\\}`, 'g');
  const sanitizedValue = sanitizeInterpolatedPromptValue(rawValue, fallbackValue);
  //audit Assumption: placeholders must be replaced globally to avoid partial interpolation; risk is inconsistent prompt text if only first occurrence is replaced; invariant is deterministic token replacement; handling strategy uses global regex.
  return template.replace(placeholderPattern, sanitizedValue);
}

/**
 * Apply a map of placeholder replacements to a template with prompt sanitization.
 * Inputs/Outputs: template + replacements object -> interpolated template.
 * Edge cases: skips undefined replacement values.
 */
function applyTemplateReplacements(
  template: string,
  replacements: Record<string, string | null | undefined>,
  fallbackValues: Record<string, string> = {}
): string {
  let interpolatedTemplate = template;
  for (const [placeholder, rawValue] of Object.entries(replacements)) {
    const fallbackValue = fallbackValues[placeholder] ?? '';
    //audit Assumption: every replacement may come from untrusted or mixed-trust sources; risk is missed sanitization on a single field; invariant is consistent sanitization pipeline; handling strategy routes all token replacement through replaceTemplateToken.
    interpolatedTemplate = replaceTemplateToken(interpolatedTemplate, placeholder, rawValue, fallbackValue);
  }
  return interpolatedTemplate;
}

/**
 * Determine whether a prompt category value can be indexed by arbitrary keys.
 * Inputs/Outputs: unknown category payload -> boolean type guard.
 * Edge cases: false for null, arrays, and primitive values.
 */
function isPromptCategoryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
    const parsedConfig = JSON.parse(configData) as PromptsConfig;
    assertProtectedConfigIntegrity('prompts_config', parsedConfig, {
      source: configPath
    });
    promptsConfig = parsedConfig;

    logger.info('Loaded prompts configuration', {
      module: 'prompts',
      operation: 'loadConfig',
      sectionsLoaded: promptsConfig ? Object.keys(promptsConfig).length : 0,
      configPath
    });

     
    return promptsConfig!;
  } catch (error) {
    logger.error('Failed to load prompts configuration', {
      module: 'prompts',
      operation: 'loadConfig',
      error: resolveErrorMessage(error)
    });

    // Cache and return fallback configuration to prevent repeated failures
    promptsConfig = {
      backstage: {
        booker_persona: 'You are a professional wrestling booker.',
        response_guidelines: 'Provide structured booking decisions.',
        instructions_suffix: ''
      },
      arcanos: {
        intake_system: 'You are ARCANOS AI system.',
        gpt5_reasoning: 'Use reasoning for analysis.',
        fallback_mode: 'System temporarily unavailable.',
        final_original_request_prefix: 'Original request:',
        final_gpt5_analysis_prefix: 'GPT-5.1 analysis:',
        final_response_instruction: 'Provide the final ARCANOS response.',
        final_review_system: 'Review GPT-5.1 analysis and deliver the final ARCANOS response.',
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
        intake_system: 'ARCANOS Intake: Route to Gaming module.',
        audit_system: 'ARCANOS Audit: Validate Gaming module response for clarity, safety, and alignment.',
        hotline_system:
          'You are ARCANOS:GAMING, a Nintendo-style hotline advisor. Provide strategies, hints, tips, and walkthroughs. Speak like a professional hotline guide: friendly, knowledgeable, and interactive.',
        web_uncertainty_guidance:
          'If you are unsure about mechanics, progression steps, or patch-specific details, ask for a guide URL so the ARCANOS web fetcher can pull the latest info instead of guessing.',
        web_context_instruction:
          'Use the sources above to keep recommendations current. If the sources do not mention the requested details, say so and ask for a guide URL to fetch rather than guessing.'
      },
      trinity: TRINITY_MESSAGES_DEFAULTS
    };
    return promptsConfig;
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
    return replaceTemplateToken(template, 'contextSummary', contextSummary);
  },
  
  GPT5_REASONING: () => loadPromptsConfig().arcanos.gpt5_reasoning,
  
  FALLBACK_MODE: (prompt: string) => {
    const template = loadPromptsConfig().arcanos.fallback_mode;
    const truncatedPrompt = prompt.slice(0, APPLICATION_CONSTANTS.FALLBACK_PROMPT_SNIPPET_LENGTH);
    return replaceTemplateToken(template, 'prompt', truncatedPrompt);
  },

  FINAL_REVIEW: (memoryContext: string) => {
    const template = loadPromptsConfig().arcanos.final_review_system;
    return replaceTemplateToken(template, 'memoryContext', memoryContext, 'No memory context provided.');
  }
} as const;

/**
 * Build the final-stage user prompt that embeds the original request.
 * Uses structured delimiters to mitigate prompt injection; consistently uses trimmed input.
 */
export const buildFinalOriginalRequestMessage = (prompt: string): string => {
  const safePrompt = sanitizeInterpolatedPromptValue(prompt, 'No request provided.');
  const prefix = loadPromptsConfig().arcanos.final_original_request_prefix;
  return `${prefix}\n<user_input>\n${safePrompt}\n</user_input>`;
};

/**
 * Build the final-stage assistant message that embeds the GPT-5.1 analysis.
 * Uses structured delimiters to mitigate indirect prompt injection; consistently uses trimmed input.
 */
export const buildFinalGpt5AnalysisMessage = (analysis: string): string => {
  const safeAnalysis = sanitizeInterpolatedPromptValue(analysis, 'No analysis provided.');
  const prefix = loadPromptsConfig().arcanos.final_gpt5_analysis_prefix ?? 'GPT-5.1 analysis:';
  return `${prefix}\n<analysis_output>\n${safeAnalysis}\n</analysis_output>`;
};

/**
 * Retrieve the final response instruction for the last stage of Trinity.
 * Inputs/Outputs: no inputs, returns the configured instruction string.
 * Edge cases: relies on fallback config when the prompts file is missing; never returns null/undefined (OpenAI requires string content).
 */
export const getFinalResponseInstruction = (): string =>
  loadPromptsConfig().arcanos.final_response_instruction ?? 'Provide the final response to the user.';

/**
 * Trinity pipeline messages (dry run, audit, pattern storage).
 * Falls back to defaults when config or keys are missing.
 */
export function getTrinityMessages(): TrinityMessages {
  const config = loadPromptsConfig();
  const t = config.trinity;
  //audit Assumption: config loader already guarantees object shape via fallback; risk is undefined trinity section in malformed runtime state; invariant is complete Trinity message set; handling strategy falls back per missing section/field.
  if (!t) return TRINITY_MESSAGES_DEFAULTS;
  return {
    dry_run_result_message: t.dry_run_result_message ?? TRINITY_MESSAGES_DEFAULTS.dry_run_result_message,
    dry_run_no_invocation_reason: t.dry_run_no_invocation_reason ?? TRINITY_MESSAGES_DEFAULTS.dry_run_no_invocation_reason,
    dry_run_reason_placeholder: t.dry_run_reason_placeholder ?? TRINITY_MESSAGES_DEFAULTS.dry_run_reason_placeholder,
    pattern_storage_label: t.pattern_storage_label ?? TRINITY_MESSAGES_DEFAULTS.pattern_storage_label,
    audit_endpoint_name: t.audit_endpoint_name ?? TRINITY_MESSAGES_DEFAULTS.audit_endpoint_name
  };
}

/**
 * Get all prompts configuration
 */
export const getPromptsConfig = (): PromptsConfig => loadPromptsConfig();

/**
 * Get prompt by category and key with template support
 */
export const getPrompt = (category: keyof PromptsConfig, key: string, replacements?: Record<string, string>): string => {
  const config = loadPromptsConfig();
  const categoryConfig = config[category];

  //audit Assumption: prompt categories must be plain key-value objects; risk is runtime key access on non-object data; invariant is safe index access; handling strategy validates category payload type before lookup.
  if (!isPromptCategoryRecord(categoryConfig)) {
    logger.warn('Prompt not found', {
      module: 'prompts',
      operation: 'getPrompt',
      category,
      key
    });
    return `[Prompt not found: ${category}.${key}]`;
  }

  const promptRecord: Record<string, unknown> = categoryConfig;

  //audit Assumption: empty string prompt values are valid configured entries; risk is false-negative "not found" checks for empty templates; invariant is key presence check independent of value truthiness; handling strategy uses hasOwnProperty.
  if (!Object.prototype.hasOwnProperty.call(promptRecord, key)) {
    logger.warn('Prompt not found', {
      module: 'prompts',
      operation: 'getPrompt',
      category,
      key
    });
    return `[Prompt not found: ${category}.${key}]`;
  }

  const rawPrompt = promptRecord[key];
  //audit Assumption: resolved prompt values must be strings for template operations; risk is runtime errors on non-string values; invariant is string return contract; handling strategy rejects invalid types with explicit fallback.
  if (typeof rawPrompt !== 'string') {
    logger.warn('Prompt value is not a string', {
      module: 'prompts',
      operation: 'getPrompt',
      category,
      key,
      valueType: typeof rawPrompt
    });
    return `[Prompt not found: ${category}.${key}]`;
  }

  let prompt = rawPrompt;

  // Apply replacements if provided
  if (replacements) {
    prompt = applyTemplateReplacements(prompt, replacements);
  }

  return prompt;
};

/**
 * Helper functions for ARCANOS prompts
 */
export const getArcanosSystemPrompt = (): string => {
  return loadPromptsConfig().arcanos.system_prompt;
};

/**
 * Build the ARCANOS user prompt using sanitized user and memory context input.
 * Inputs/Outputs: user input string + optional memory context -> interpolated prompt string.
 * Edge cases: blank user input resolves to explicit fallback text.
 */
export const getArcanosUserPrompt = (userInput: string, memoryContext?: string): string => {
  const template = loadPromptsConfig().arcanos.user_prompt;
  const safeMemoryContext = sanitizeInterpolatedPromptValue(memoryContext);
  const memorySection = safeMemoryContext
    ? `\n[MEMORY CONTEXT INTEGRATION]\n${safeMemoryContext}\nApply relevant memory context to maintain continuity in your response.`
    : '';

  return template
    .replace('{memoryContext}', memorySection)
    .replace('{userInput}', sanitizeInterpolatedPromptValue(userInput, 'No request provided.'));
};

export const getRoutingActiveMessage = (): string => {
  return loadPromptsConfig().system.routing_active;
};

/**
 * Compose the secure reasoning integration prompt from pipeline artifacts.
 * Inputs/Outputs: user query + reasoning artifacts -> formatted synthesis prompt.
 * Edge cases: each interpolated value is sanitized before insertion.
 */
export const getSecureReasoningIntegrationPrompt = (
  userInput: string,
  reason: string,
  complianceStatus: string,
  structuredAnalysis: string,
  problemSolvingSteps: string,
  recommendations: string
): string => {
  const template = loadPromptsConfig().arcanos.secure_reasoning_integration;
  return applyTemplateReplacements(template, {
    userInput,
    reason,
    complianceStatus,
    structuredAnalysis,
    problemSolvingSteps,
    recommendations
  });
};

/**
 * Build the dedicated security reasoning engine prompt with sanitized user input.
 * Inputs/Outputs: user input string -> security reasoning prompt string.
 * Edge cases: blank input resolves to explicit fallback text.
 */
export const getSecurityReasoningEnginePrompt = (userInput: string): string => {
  const template = loadPromptsConfig().security.reasoning_engine_prompt;
  return replaceTemplateToken(template, 'userInput', userInput, 'No request provided.');
};

/**
 * Build a structured security response template from reasoning engine outputs.
 * Inputs/Outputs: summary + content + compliance values -> formatted response block.
 * Edge cases: each missing value is replaced with a safe fallback string.
 */
export const getStructuredSecurityResponseTemplate = (
  inputSummary: string,
  content: string,
  complianceStatus: string,
  redactionsApplied: string
): string => {
  const template = loadPromptsConfig().security.structured_response_template;
  return applyTemplateReplacements(
    template,
    {
      inputSummary,
      content,
      complianceStatus,
      redactionsApplied
    },
    {
      inputSummary: 'No summary provided.',
      complianceStatus: 'Compliance status unavailable.',
      redactionsApplied: 'No redactions reported.'
    }
  );
};
