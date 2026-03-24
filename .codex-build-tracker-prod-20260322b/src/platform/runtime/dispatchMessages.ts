export const DISPATCH_V9_LOG_MESSAGES = {
  decision: 'Dispatch v9 decision evaluated',
  shadowAllow: 'Dispatch v9 shadow mode bypassed enforcement',
  blocked: 'Dispatch v9 blocked conflicting route attempt',
  rerouted: 'Dispatch v9 rerouted conflicting route attempt',
  failsafe: 'Dispatch v9 failsafe response triggered'
} as const;

export const DISPATCH_V9_ERROR_CODES = {
  MEMORY_ROUTE_CONFLICT: 'MEMORY_ROUTE_CONFLICT',
  DISPATCH_FAILSAFE: 'DISPATCH_FAILSAFE'
} as const;

