import { sanitizeInput } from '../utils/security.js';
import { createCentralizedCompletion, generateMockResponse, hasValidAPIKey } from './openai.js';
import { getAuditSafeMode, interpretCommand, setAuditSafeMode } from './auditSafeToggle.js';
import { extractTextPrompt } from '../utils/payloadNormalization.js';

export type CommandName = 'audit-safe:set-mode' | 'audit-safe:interpret' | 'ai:prompt';

type CommandHandler = (payload?: Record<string, any>) => Promise<CommandExecutionResult>;

export interface CommandDefinition {
  name: CommandName;
  description: string;
  requiresConfirmation: boolean;
  payloadExample?: Record<string, unknown>;
}

export interface CommandExecutionResult {
  success: boolean;
  command: CommandName;
  message: string;
  output?: Record<string, unknown>;
  metadata: {
    executedAt: string;
    auditSafeMode: string;
  };
}

const AVAILABLE_COMMANDS: Record<CommandName, CommandDefinition> = {
  'audit-safe:set-mode': {
    name: 'audit-safe:set-mode',
    description: 'Directly set the Audit-Safe enforcement mode.',
    requiresConfirmation: true,
    payloadExample: { mode: 'true' }
  },
  'audit-safe:interpret': {
    name: 'audit-safe:interpret',
    description: 'Interpret a natural-language instruction to adjust Audit-Safe mode.',
    requiresConfirmation: true,
    payloadExample: { instruction: 'Enable strict audit safe mode' }
  },
  'ai:prompt': {
    name: 'ai:prompt',
    description: 'Execute an AI command through the centralized OpenAI routing pipeline.',
    requiresConfirmation: true,
    payloadExample: { prompt: 'Summarize current system status' }
  }
};

const VALID_AUDIT_MODES: Array<'true' | 'false' | 'passive' | 'log-only'> = ['true', 'false', 'passive', 'log-only'];

const commandHandlers: Record<CommandName, CommandHandler> = {
  'audit-safe:set-mode': async (payload) => {
    const mode = typeof payload?.mode === 'string' ? (payload.mode as typeof VALID_AUDIT_MODES[number]) : undefined;

    if (!mode || !VALID_AUDIT_MODES.includes(mode)) {
      return buildResult('audit-safe:set-mode', false, "Invalid mode. Use 'true', 'false', 'passive', or 'log-only'.");
    }

    setAuditSafeMode(mode);

    return buildResult('audit-safe:set-mode', true, `Audit-Safe mode set to ${mode}.`, {
      mode
    });
  },
  'audit-safe:interpret': async (payload) => {
    const instruction = typeof payload?.instruction === 'string' ? sanitizeInput(payload.instruction) : '';

    if (!instruction) {
      return buildResult('audit-safe:interpret', false, 'Instruction text is required.');
    }

    await interpretCommand(instruction);

    return buildResult('audit-safe:interpret', true, 'Instruction processed. Audit-Safe mode updated if recognized.', {
      instruction,
      mode: getAuditSafeMode()
    });
  },
  'ai:prompt': async (payload) => {
    const prompt = extractTextPrompt(payload, ['prompt']);

    if (!prompt) {
      return buildResult('ai:prompt', false, 'Prompt text is required.');
    }

    const sanitizedPrompt = sanitizeInput(prompt);

    if (!hasValidAPIKey()) {
      const mock = generateMockResponse(sanitizedPrompt, 'ask');
      return buildResult('ai:prompt', true, 'OpenAI API key not configured - returning mock response.', {
        result: mock.result,
        meta: mock.meta,
        fallback: true
      });
    }

    try {
      const response = await createCentralizedCompletion([
        { role: 'user', content: sanitizedPrompt }
      ]);

      if ('choices' in response) {
        const firstChoice = response.choices[0];
        const content = firstChoice?.message?.content ?? '';
        return buildResult('ai:prompt', true, 'AI command executed successfully.', {
          result: content,
          usage: response.usage ?? null,
          model: response.model
        });
      }

      return buildResult('ai:prompt', true, 'Streaming response started.', {
        result: null,
        streaming: true
      });
    } catch (error: any) {
      return buildResult('ai:prompt', false, error?.message || 'Failed to execute AI command.');
    }
  }
};

function buildResult(
  command: CommandName,
  success: boolean,
  message: string,
  output: Record<string, unknown> | undefined = undefined
): CommandExecutionResult {
  return {
    success,
    command,
    message,
    output,
    metadata: {
      executedAt: new Date().toISOString(),
      auditSafeMode: getAuditSafeMode()
    }
  };
}

export async function executeCommand(
  command: CommandName,
  payload: Record<string, any> = {}
): Promise<CommandExecutionResult> {
  const handler = commandHandlers[command];

  if (!handler) {
    return buildResult(command, false, 'Unsupported command.');
  }

  return handler(payload);
}

export function listAvailableCommands(): CommandDefinition[] {
  return Object.values(AVAILABLE_COMMANDS);
}

export default {
  executeCommand,
  listAvailableCommands
};
