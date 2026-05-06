export const GPT_ACCESS_SCOPES = [
  'runtime.read',
  'workers.read',
  'queue.read',
  'jobs.create',
  'jobs.result',
  'logs.read_sanitized',
  'db.explain_approved',
  'mcp.approved_readonly',
  'capabilities.read',
  'capabilities.run',
  'diagnostics.read',
  'workers.recover'
] as const;

export type GptAccessScope = (typeof GPT_ACCESS_SCOPES)[number];

