import type OpenAI from 'openai';
import { getDefaultModel } from "@services/openai.js";
import { getTokenParameter } from "@shared/tokenParameterHelper.js";
import { config } from "@platform/runtime/config.js";
import { getEnv } from "@platform/runtime/env.js";
import { createPendingDaemonActions, queueDaemonCommandForInstance } from "@routes/api-daemon.js";
import type { AskResponse } from './types.js';

type DaemonMetadata = {
  source?: string;
  instanceId?: string;
};

type PendingDaemonAction = {
  daemon: string;
  payload: Record<string, unknown>;
  summary: string;
};

export type ConfirmationRequiredResponse = {
  confirmation_required: true;
  confirmation_token: string;
  pending_actions: PendingDaemonAction[];
};

const DAEMON_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a command on the user machine via the connected daemon. The user may ask in natural or vague language; infer intent and build the appropriate command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'capture_screen',
      description: 'Capture and analyze the user screen or camera via the connected daemon. The user may ask in natural or vague language (e.g. look at my screen, what do you see, show the camera); infer intent.',
      parameters: {
        type: 'object',
        properties: {
          use_camera: { type: 'boolean', description: 'Set true to use the camera instead of the screen.' }
        }
      }
    }
  }
];

const DAEMON_TOOL_SYSTEM_PROMPT = [
  'You are ARCANOS in daemon mode. You may use run_command and capture_screen when the user asks; run_command is sensitive and will require user confirmation.',
  'A daemon is connected to the user machine. Accept natural or vague language for all daemon actions; infer intent.',
  'When the user says "take control", "you drive", "handle it", or similar, treat it as permission to use daemon tools and to chain multiple tool calls in one turn. You may emit multiple tool calls in one response when the task requires several actions.',
  'For run_command: when the user wants to run a command, open a file, execute something, or perform an action on their machine, call run_command with the appropriate command string.',
  'For capture_screen: when the user wants to see the screen or camera (e.g. look at my screen, what do you see, show the camera), call capture_screen with use_camera true for camera, false for screen.',
  'If none of the above applies, respond normally without tool calls.'
].join(' ');

// Security: Default to requiring confirmation for sensitive daemon actions
// preemptive=true means "preemptively execute without confirmation" (skip confirmation)
// preemptive=false/undefined means "require confirmation" (default secure behavior)
// This ensures security by default - confirmation gate is enabled unless explicitly disabled
// Also check direct env var for backward compatibility
const explicitConfirm = getEnv('CONFIRM_SENSITIVE_DAEMON_ACTIONS');
const CONFIRM_SENSITIVE_DAEMON_ACTIONS = explicitConfirm !== undefined 
  ? explicitConfirm !== 'false' 
  : !config.fallback?.preemptive;

function extractDaemonMetadata(metadata?: Record<string, unknown>): DaemonMetadata {
  if (!metadata || typeof metadata !== 'object') {
    //audit Assumption: metadata optional; risk: missing daemon linkage; invariant: undefined fields; handling: return empty.
    return {};
  }

  const source = typeof metadata.source === 'string' ? metadata.source : undefined;
  const instanceId = typeof metadata.instanceId === 'string' ? metadata.instanceId : undefined;
  return { source, instanceId };
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
  const tokenParams = getTokenParameter(model, 256);

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: DAEMON_TOOL_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    tools: DAEMON_TOOLS,
    tool_choice: 'auto',
    ...tokenParams
  });

  const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
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
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      //audit Assumption: tool args must be JSON; risk: invalid payload; invariant: skip invalid; handling: count error.
      toolErrors += 1;
      continue;
    }

    if (toolName === 'run_command') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) {
        //audit Assumption: command required; risk: empty execution; invariant: skip; handling: count error.
        toolErrors += 1;
        continue;
      }
      if (CONFIRM_SENSITIVE_DAEMON_ACTIONS) {
        //audit Assumption: sensitive commands require confirmation; risk: auto-execution; invariant: pending action created; handling: defer.
        pendingActions.push({
          daemon: 'run',
          payload: { command },
          summary: `run: ${command}`
        });
      } else {
        //audit Assumption: confirmation disabled; risk: unsafe execution; invariant: queue immediately; handling: enqueue.
        const commandId = queueDaemonCommandForInstance(instanceId, 'run', { command });
        if (!commandId) {
          //audit Assumption: missing token prevents queueing; risk: orphan instanceId; invariant: skip; handling: count error.
          toolErrors += 1;
          continue;
        }
        queuedIds.push(commandId);
      }
      continue;
    }

    if (toolName === 'capture_screen') {
      const useCamera = Boolean(args.use_camera);
      const commandId = queueDaemonCommandForInstance(instanceId, 'see', { use_camera: useCamera });
      if (!commandId) {
        //audit Assumption: missing token prevents queueing; risk: orphan instanceId; invariant: skip; handling: count error.
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
    //audit Assumption: pending actions require confirmation; risk: missing pending token; invariant: confirmation token returned; handling: create pending store.
    const confirmationToken = createPendingDaemonActions(instanceId, pendingActions);
    return {
      confirmation_required: true,
      confirmation_token: confirmationToken,
      pending_actions: pendingActions
    };
  }

  let resultText = '';
  if (queuedIds.length > 0) {
    //audit Assumption: queued commands should be acknowledged; risk: user uncertainty; invariant: confirmation returned; handling: summarize queue.
    const plural = queuedIds.length === 1 ? 'action' : 'actions';
    resultText = `Queued ${queuedIds.length} daemon ${plural}.`;
    if (toolErrors > 0) {
      resultText += ' Some requests could not be queued.';
    }
  } else {
    //audit Assumption: zero queued actions is a failure; risk: silent no-op; invariant: user notified; handling: return fallback text.
    resultText = 'Unable to queue daemon actions. Please try again.';
  }

  const usage = response.usage;
  const tokens = usage
    ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    : undefined;
  const responseId = response.id || `daemon-tool-${Date.now()}`;
  const created = typeof response.created === 'number' ? response.created : Date.now();

  return {
    result: resultText,
    module: 'daemon-tools',
    activeModel: response.model,
    fallbackFlag: false,
    meta: {
      tokens,
      id: responseId,
      created
    }
  };
}
