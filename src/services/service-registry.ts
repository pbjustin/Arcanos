export function serviceAlreadyRegistered(name: string): boolean {
  const globalAny = globalThis as any;
  if (!globalAny.__serviceRegistry) {
    globalAny.__serviceRegistry = new Set<string>();
  }
  if (globalAny.__serviceRegistry.has(name)) {
    return true;
  }
  globalAny.__serviceRegistry.add(name);
  return false;
}
