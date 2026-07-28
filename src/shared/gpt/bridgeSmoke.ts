export const GPT_HEALTH_ECHO_ACTION = 'health_echo';
export const GPT_ECHO_ACTION = 'echo';
export const BRIDGE_SMOKE_OUTPUT = 'OK';

export type GptBridgeSmokeAction =
  | typeof GPT_HEALTH_ECHO_ACTION
  | typeof GPT_ECHO_ACTION;

export type BridgeSmokeCompletedOutput = Record<string, unknown> & {
  ok: true;
  status: 'completed';
  output: typeof BRIDGE_SMOKE_OUTPUT;
};

export interface QueuedBridgeSmokeInput {
  bridgeSmoke?: true;
  bridgeAction?: GptBridgeSmokeAction;
}

export function isGptBridgeSmokeAction(value: unknown): value is GptBridgeSmokeAction {
  return value === GPT_HEALTH_ECHO_ACTION || value === GPT_ECHO_ACTION;
}

export function buildBridgeSmokeCompletedOutput(): BridgeSmokeCompletedOutput {
  return {
    ok: true,
    status: 'completed',
    output: BRIDGE_SMOKE_OUTPUT,
  };
}

export function isQueuedBridgeSmokeJobInput(
  input: QueuedBridgeSmokeInput
): boolean {
  return input.bridgeSmoke === true && isGptBridgeSmokeAction(input.bridgeAction);
}
