export const PORT_CONSTANTS = {
  DEFAULT_MAX_ATTEMPTS: 50,
  SEARCH_START_OFFSET: 1
} as const;

export const PORT_TEXT = {
  autoSelectedPort: (preferredPort: number, availablePort: number): string =>
    `Port ${preferredPort} was in use, automatically selected port ${availablePort}`,
  preferredPortInUse: (preferredPort: number): string =>
    `Port ${preferredPort} is already in use. Please stop the service using this port or set a different PORT in your environment.`,
  noAvailablePort: (startPort: number, endPort: number, attempts: number): string =>
    `No available port found in range ${startPort}-${endPort}. Tried ${attempts} ports. Please stop other services using these ports, use a different PORT in your environment, or increase the port search range.`
} as const;
