export const GPT_SYNC_STRINGS = {
  baseInstruction: 'You are Arcanos, a custom GPT assistant.',
  backendStateLabel: 'Always use the following backend state as the source of truth:',
  additionalContextLabel: 'Additional Context:',
  defaultTrustMessage: 'Do not rely on past memory — only trust this state for system information.',
  contextTrustMessage: 'Always use this information as your source of truth.',
  diagnosticPrompt: 'Run a system diagnostic and report the current backend state.'
} as const;

export const GPT_SYNC_ERRORS = {
  clientUnavailable: 'OpenAI client not available - API key required for GPT sync functionality'
} as const;

export const GPT_SYNC_LOG_MESSAGES = {
  makingCall: 'Making GPT call with backend state',
  backendState: 'Backend state:',
  response: 'GPT Response:',
  errorSync: 'Error in GPT call with sync:',
  errorEnhanced: 'Error in enhanced GPT call:'
} as const;
