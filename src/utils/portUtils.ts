/**
 * Port Utility Functions
 * Handles port availability checking and automatic port selection
 */

import { createServer, Server } from 'http';
import { PORT_CONSTANTS, PORT_TEXT } from '../config/portMessages.js';

const DEFAULT_HOST = '0.0.0.0';
const { DEFAULT_MAX_ATTEMPTS, SEARCH_START_OFFSET } = PORT_CONSTANTS;

function createPortInUseError(preferredPort: number): Error {
  return new Error(PORT_TEXT.preferredPortInUse(preferredPort));
}

function createPortSearchError(startPort: number, attempts: number): Error {
  const endPort = startPort + attempts - 1;
  return new Error(PORT_TEXT.noAvailablePort(startPort, endPort, attempts));
}

/**
 * Check if a port is available for binding
 * @param port Port number to check
 * @param host Host to bind to (default: '0.0.0.0')
 * @returns Promise<boolean> True if port is available, false otherwise
 */
export async function isPortAvailable(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const server: Server = createServer();

    const cleanup = () => {
      server.removeAllListeners('listening');
      server.removeAllListeners('error');
    };

    server.once('listening', () => {
      server.close(() => {
        cleanup();
        resolve(true);
      });
    });

    server.once('error', () => {
      cleanup();
      resolve(false);
    });

    server.listen(port, host);
  });
}

/**
 * Find the next available port starting from the given port
 * @param startPort Starting port number
 * @param host Host to bind to (default: '0.0.0.0')
 * @param maxAttempts Maximum number of ports to try (default: 50)
 * @returns Promise<number> Next available port number
 * @throws Error if no available port found within maxAttempts
 */
export async function findAvailablePort(
  startPort: number,
  host: string = DEFAULT_HOST,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS
): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port, host)) {
      return port;
    }
  }

  throw createPortSearchError(startPort, maxAttempts);
}

/**
 * Get an available port, with automatic fallback if the preferred port is in use
 * @param preferredPort The preferred port to use
 * @param host Host to bind to (default: '0.0.0.0')
 * @param enableAutoSelect Whether to auto-select another port if preferred is unavailable (default: true)
 * @returns Promise<{port: number, isPreferred: boolean, message?: string}>
 */
export async function getAvailablePort(
  preferredPort: number,
  host: string = DEFAULT_HOST,
  enableAutoSelect: boolean = true
): Promise<{port: number, isPreferred: boolean, message?: string}> {
  if (await isPortAvailable(preferredPort, host)) {
    return {
      port: preferredPort,
      isPreferred: true
    };
  }

  if (!enableAutoSelect) {
    throw createPortInUseError(preferredPort);
  }

  const searchStart = preferredPort + SEARCH_START_OFFSET;

  try {
    const availablePort = await findAvailablePort(searchStart, host);
    return {
      port: availablePort,
      isPreferred: false,
      message: PORT_TEXT.autoSelectedPort(preferredPort, availablePort)
    };
  } catch {
    throw createPortSearchError(searchStart, DEFAULT_MAX_ATTEMPTS);
  }
}