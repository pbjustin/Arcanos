/* ============================================================
   BRAIN REGISTRY
   File: src/brain/brainRegistry.ts
   ============================================================ */

export interface Brain {
  execute(payload: any): Promise<any>;
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
