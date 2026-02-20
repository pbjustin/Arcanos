/* ============================================================
   BRAIN REGISTRY
   File: src/brain/brainRegistry.ts
   ============================================================ */

export interface BrainPayload {
  prompt: string;
  sessionId: string;
  lineageId: string;
}

export interface BrainResponse {
  module: string;
  activeModel: string;
  output_text: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface Brain {
  execute(payload: BrainPayload): Promise<BrainResponse>;
}

const registry: Record<string, Brain> = {};

export function registerBrain(name: string, brain: Brain) {
  registry[name] = brain;
}

export function getBrain(name: string): Brain | undefined {
  return registry[name];
}

export function brainExists(name: string): boolean {
  return !!registry[name];
}
