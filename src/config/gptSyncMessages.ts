export const GPT_SYNC_STRINGS = {
  baseInstruction: 'You are Arcanos, a custom GPT assistant.',
  backendStateLabel: 'Always use the following backend state as the source of truth:',
  additionalContextLabel: 'Additional Context:',
  defaultTrustMessage: 'Do not rely on past memory — only trust this state for system information.',
  contextTrustMessage: 'Always use this information as your source of truth.',
  diagnosticPrompt: 'Run a system diagnostic and report the current backend state.'
} as const;
