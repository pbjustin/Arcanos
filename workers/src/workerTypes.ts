export interface WorkerContext {
  log: (message: string) => Promise<void>;
  error: (message: string, ...args: unknown[]) => Promise<void>;
  db: {
    query: (
      text: string,
      params?: unknown[]
    ) => Promise<{ rows?: Array<Record<string, unknown>> }>;
  };
  ai: {
    ask: (prompt: string) => Promise<string>;
  };
}
