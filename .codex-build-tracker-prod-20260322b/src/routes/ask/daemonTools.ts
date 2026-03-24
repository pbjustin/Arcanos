import type OpenAI from 'openai';
import { z } from 'zod';
import { getDefaultModel } from "@services/openai.js";
import { buildFunctionToolSet, type FunctionToolDefinition } from '@services/openai/functionTools.js';
import { getTokenParameter } from "@shared/tokenParameterHelper.js";
import { shouldStoreOpenAIResponses } from "@config/openaiStore.js";
import { getEnv } from "@platform/runtime/env.js";
import {
  createPendingDaemonActions,
  getDaemonCommandResultForInstance,
  queueDaemonCommandForInstance
} from "@routes/api-daemon.js";
import type { AskResponse } from './types.js';
import { parseToolArgumentsWithSchema } from '@services/safety/aiOutputBoundary.js';
import { emitSafetyAuditEvent } from '@services/safety/auditEvents.js';
import { extractResponseOutputText } from '@arcanos/openai/responseParsing';
import { buildToolAskResponse } from './toolRuntime.js';
import {
  buildInitialToolLoopTranscript,
  buildToolLoopContinuationRequest,
  type ToolLoopFunctionCallOutput
} from './toolLoop.js';

type DaemonMetadata = {
  source?: string;
  instanceId?: string;
};

type PendingDaemonAction = {
  daemon: string;
  payload: Record<string, unknown>;
  summary: string;
};

type ChatCompletionToolCall = {
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type ConfirmationRequiredResponse = {
  confirmation_required: true;
  confirmation_token: string;
  pending_actions: PendingDaemonAction[];
};

const daemonToolDefinitions: FunctionToolDefinition[] = [
  {
    name: 'run_command',
    description:
      'Run a command on the user machine via the connected daemon. The user may ask in natural or vague language; infer intent and build the appropriate command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute.' }
      },
      required: ['command']
    }
  },
  {
    name: 'capture_screen',
    description:
      'Capture and analyze the user screen or camera via the connected daemon. The user may ask in natural or vague language (e.g. look at my screen, what do you see, show the camera); infer intent.',
    parameters: {
      type: 'object',
      properties: {
        use_camera: {
          type: 'boolean',
          description: 'Set true to use the camera instead of the screen.'
        }
      }
    }
  }
];

const { chatCompletionTools: daemonChatCompletionTools, responsesTools: daemonResponsesTools } =
  buildFunctionToolSet(daemonToolDefinitions);

const DAEMON_TOOL_SYSTEM_PROMPT = [
  'You are ARCANOS in daemon mode. You may use run_command and capture_screen when the user asks; run_command is sensitive and always requires deterministic user confirmation.',
  'A daemon is connected to the user machine. Accept natural or vague language for all daemon actions; infer intent.',
  'When the user says "take control", "you drive", "handle it", or similar, treat it as permission to use daemon tools and to chain multiple tool calls in one turn. You may emit multiple tool calls in one response when the task requires several actions.',
  'For run_command: when the user wants to run a command, open a file, execute something, or perform an action on their machine, call run_command with the appropriate command string.',
  'For capture_screen: when the user wants to see the screen or camera (e.g. look at my screen, what do you see, show the camera), call capture_screen with use_camera true for camera, false for screen.',
  'If none of the above applies, respond normally without tool calls.'
].join(' ');

const runCommandArgsSchema = z.object({
  command: z.string().trim().min(1).max(8000)
});

const captureScreenArgsSchema = z.object({
  use_camera: z.boolean().optional().default(false)
});

const DAEMON_RESULT_WAIT_MS = Number.parseInt(getEnv('DAEMON_RESULT_WAIT_MS', '8000'), 10) || 8000;
const DAEMON_RESULT_POLL_MS = Number.parseInt(getEnv('DAEMON_RESULT_POLL_MS', '250'), 10) || 250;

async function waitForDaemonCommandResult(
  instanceId: string,
  commandId: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const result = getDaemonCommandResultForInstance(instanceId, commandId);
    if (result) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_RESULT_POLL_MS));
  }
  return null;
}

function extractDaemonMetadata(metadata?: Record<string, unknown>): DaemonMetadata {
  if (!metadata || typeof metadata !== 'object') {
    //audit Assumption: metadata optional; risk: missing daemon linkage; invariant: undefined fields; handling: return empty.
    return {};
  }

  const source = typeof metadata.source === 'string' ? metadata.source : undefined;
  const instanceId = typeof metadata.instanceId === 'string' ? metadata.instanceId : undefined;
  return { source, instanceId };
}

async function tryDispatchDaemonToolsWithChatCompletions(
  chatCompletionsApi: { create: (payload: Record<string, unknown>) => Promise<any> },
  model: string,
  tokenParams: Record<string, unknown>,
  prompt: string,
  instanceId: string
): Promise<AskResponse | ConfirmationRequiredResponse | null> {
  const response = await chatCompletionsApi.create({
    model,
    messages: [
      { role: 'system', content: DAEMON_TOOL_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    tools: daemonChatCompletionTools,
    tool_choice: 'auto',
    ...tokenParams
  });

  const toolCalls: ChatCompletionToolCall[] = response?.choices?.[0]?.message?.tool_calls ?? [];
  if (!toolCalls.length) {
    //audit Assumption: no tool calls means standard chat path; risk: missed tool action; invariant: fall back to trinity; handling: return null.
    return null;
  }

  const queuedIds: string[] = [];
  const pendingActions: PendingDaemonAction[] = [];
  let toolErrors = 0;

  for (const call of toolCalls) {
    if (call.type !== 'function' || !call.function?.name) {
      //audit Assumption: tool calls should be functions; risk: unexpected tool type; invariant: skip invalid; handling: count error.
      toolErrors += 1;
      continue;
    }

    const toolName = call.function.name;
    const rawArgs = call.function.arguments || '{}';

    if (toolName === 'run_command') {
      let parsedArgs: z.infer<typeof runCommandArgsSchema>;
      try {
        parsedArgs = parseToolArgumentsWithSchema(rawArgs, runCommandArgsSchema, 'daemonTools.run_command');
      } catch (error) {
        toolErrors += 1;
        emitSafetyAuditEvent({
          event: 'daemon_tool_invalid_run_command_args',
          severity: 'warn',
          details: {
            instanceId,
            message: error instanceof Error ? error.message : String(error)
          }
        });
        continue;
      }

      const command = parsedArgs.command.trim();
      if (!command.length) {
        //audit Assumption: command required; risk: empty execution; invariant: skip; handling: count error.
        toolErrors += 1;
        continue;
      }

      //audit Assumption: irreversible run_command actions must always require deterministic confirmation; risk: model output directly mutates host state; invariant: run commands are deferred via confirmation token; handling: queue pending action only.
      pendingActions.push({
        daemon: 'run',
        payload: { command },
        summary: `run: ${command}`
      });
      continue;
    }

    if (toolName === 'capture_screen') {
      let parsedArgs: z.input<typeof captureScreenArgsSchema>;
      try {
        parsedArgs = parseToolArgumentsWithSchema(rawArgs, captureScreenArgsSchema, 'daemonTools.capture_screen');
      } catch (error) {
        toolErrors += 1;
        emitSafetyAuditEvent({
          event: 'daemon_tool_invalid_capture_screen_args',
          severity: 'warn',
          details: {
            instanceId,
            message: error instanceof Error ? error.message : String(error)
          }
        });
        continue;
      }

      const useCamera = parsedArgs.use_camera ?? false;
      const commandId = queueDaemonCommandForInstance(instanceId, 'see', { use_camera: useCamera });
      if (!commandId) {
        toolErrors += 1;
        continue;
      }
      queuedIds.push(commandId);
      continue;
    }

    //audit Assumption: unknown tool names should be ignored; risk: unsupported calls; invariant: skip; handling: count error.
    toolErrors += 1;
  }

  if (pendingActions.length > 0) {
    const confirmationToken = createPendingDaemonActions(instanceId, pendingActions);
    return {
      confirmation_required: true,
      confirmation_token: confirmationToken,
      pending_actions: pendingActions
    };
  }

  let resultText = '';
  if (queuedIds.length > 0) {
    const plural = queuedIds.length === 1 ? 'action' : 'actions';
    resultText = `Queued ${queuedIds.length} daemon ${plural}.`;
    if (toolErrors > 0) {
      resultText += ' Some requests could not be queued.';
    }
  } else {
    resultText = 'Unable to queue daemon actions. Please try again.';
  }

  return buildToolAskResponse('daemon-tools', response, resultText, 'daemon-tool');
}

export async function tryDispatchDaemonTools(
  client: OpenAI,
  prompt: string,
  metadata?: Record<string, unknown>
): Promise<AskResponse | ConfirmationRequiredResponse | null> {
  const { source, instanceId } = extractDaemonMetadata(metadata);

  if (source !== 'daemon' || !instanceId) {
    //audit Assumption: daemon tools only when daemon-linked; risk: unintended commands; invariant: daemon metadata required; handling: skip.
    return null;
  }

  const model = getDefaultModel();
  const tokenParams = getTokenParameter(model, 256) as Record<string, unknown>;
  const maxOutputTokens =
    (tokenParams as { max_completion_tokens?: number; max_tokens?: number }).max_completion_tokens ??
    (tokenParams as { max_completion_tokens?: number; max_tokens?: number }).max_tokens ??
    256;

  const responsesApi = (client as any)?.responses;
  const chatCompletionsApi = (client as any)?.chat?.completions;

  if (!responsesApi?.create && !chatCompletionsApi?.create) {
    throw new Error('OpenAI client does not expose responses.create or chat.completions.create');
  }

  if (!responsesApi?.create && chatCompletionsApi?.create) {
    return tryDispatchDaemonToolsWithChatCompletions(
      chatCompletionsApi as { create: (payload: Record<string, unknown>) => Promise<any> },
      model,
      tokenParams,
      prompt,
      instanceId
    );
  }

  // Tool-calling loop: keep executing function calls until the model returns a text response
  // or we reach a hard cap. This enables "tool output continuation".
  const MAX_TURNS = 8;
  const storeOpenAIResponses = shouldStoreOpenAIResponses();
  let toolLoopTranscript = buildInitialToolLoopTranscript(prompt);

  let response: any = await responsesApi.create({
    model,
    store: storeOpenAIResponses,
    instructions: DAEMON_TOOL_SYSTEM_PROMPT,
    input: toolLoopTranscript,
    tools: daemonResponsesTools,
    tool_choice: 'auto',
    max_output_tokens: maxOutputTokens
  });

  let lastText = extractResponseOutputText(response, '');

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const toolCalls = (Array.isArray(response?.output) ? response.output : []).filter(
      (item: any) => item && item.type === 'function_call'
    );

    if (!toolCalls.length) {
      // No tool calls -> return the model's natural language response (if any).
      if (!lastText || lastText.trim().length === 0) {
        //audit Assumption: empty model output should fall back to null (let main ask path handle); risk: confusing empty reply; invariant: don't return empty; handling: return null.
        return null;
      }
      return buildToolAskResponse('daemon-tools', response, lastText, 'daemon-tool');
    }

    const pendingActions: PendingDaemonAction[] = [];
    const functionCallOutputs: ToolLoopFunctionCallOutput[] = [];

    for (const call of toolCalls) {
      const toolName = typeof call?.name === 'string' ? call.name : '';
      const callId = typeof call?.call_id === 'string' ? call.call_id : '';
      const rawArgs = call?.arguments || '{}';

      if (!toolName || !callId) {
        continue;
      }

      if (toolName === 'run_command') {
        let parsedArgs: z.infer<typeof runCommandArgsSchema>;
        try {
          parsedArgs = parseToolArgumentsWithSchema(rawArgs, runCommandArgsSchema, 'daemonTools.run_command');
        } catch (error) {
          emitSafetyAuditEvent({
            event: 'daemon_tool_invalid_run_command_args',
            severity: 'warn',
            details: {
              instanceId,
              message: error instanceof Error ? error.message : String(error)
            }
          });
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              ok: false,
              error: 'INVALID_ARGUMENTS',
              message: error instanceof Error ? error.message : String(error)
            })
          });
          continue;
        }

        const command = parsedArgs.command.trim();
        if (!command.length) {
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              ok: false,
              error: 'EMPTY_COMMAND'
            })
          });
          continue;
        }

        //audit Assumption: irreversible run_command actions must always require deterministic confirmation; risk: model output directly mutates host state; invariant: run commands are deferred via confirmation token; handling: queue pending action only.
        pendingActions.push({
          daemon: 'run',
          payload: { command },
          summary: `run: ${command}`
        });

        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            ok: true,
            queued_for_confirmation: true,
            command,
            confirmation_required: true
          })
        });

        continue;
      }

      if (toolName === 'capture_screen') {
        let parsedArgs: z.input<typeof captureScreenArgsSchema>;
        try {
          parsedArgs = parseToolArgumentsWithSchema(rawArgs, captureScreenArgsSchema, 'daemonTools.capture_screen');
        } catch (error) {
          emitSafetyAuditEvent({
            event: 'daemon_tool_invalid_capture_screen_args',
            severity: 'warn',
            details: {
              instanceId,
              message: error instanceof Error ? error.message : String(error)
            }
          });
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              ok: false,
              error: 'INVALID_ARGUMENTS',
              message: error instanceof Error ? error.message : String(error)
            })
          });
          continue;
        }

        const useCamera = parsedArgs.use_camera ?? false;
        const commandId = queueDaemonCommandForInstance(instanceId, 'see', { use_camera: useCamera });

        if (!commandId) {
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              ok: false,
              error: 'QUEUE_FAILED'
            })
          });
          continue;
        }

        const daemonResult = await waitForDaemonCommandResult(instanceId, commandId, DAEMON_RESULT_WAIT_MS);

        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            ok: true,
            queued: daemonResult ? false : true,
            command_id: commandId,
            use_camera: useCamera,
            result: daemonResult ?? undefined
          })
        });

        continue;
      }

      functionCallOutputs.push({
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({
          ok: false,
          error: 'UNKNOWN_TOOL',
          name: toolName
        })
      });
    }

    if (pendingActions.length > 0) {
      const confirmationToken = createPendingDaemonActions(instanceId, pendingActions);
      return {
        confirmation_required: true,
        confirmation_token: confirmationToken,
        pending_actions: pendingActions
      };
    }

    const continuationRequest = buildToolLoopContinuationRequest({
      instructions: DAEMON_TOOL_SYSTEM_PROMPT,
      maxOutputTokens,
      model,
      previousResponse: response,
      storeResponses: storeOpenAIResponses,
      tools: daemonResponsesTools,
      transcript: toolLoopTranscript,
      functionCallOutputs
    });
    toolLoopTranscript = continuationRequest.nextTranscript;
    response = await responsesApi.create(continuationRequest.request);

    lastText = extractResponseOutputText(response, lastText);
  }

  // If we exhausted the tool loop, fall back to the main ask flow.
  return null;
}
