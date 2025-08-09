/**
 * Port Utility Functions
 * Handles port availability checking and automatic port selection
 */

import { createServer, Server } from 'http';

/**
 * Check if a port is available for binding
 * @param port Port number to check
 * @param host Host to bind to (default: '0.0.0.0')
 * @returns Promise<boolean> True if port is available, false otherwise
 */
export async function isPortAvailable(port: number, host: string = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server: Server = createServer();
    
    server.listen(port, host, () => {
      server.close(() => {
        resolve(true);
      });
    });
    
    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });
  });
}

/**
 * Find the next available port starting from the given port
 * @param startPort Starting port number
 * @param host Host to bind to (default: '0.0.0.0')
 * @param maxAttempts Maximum number of ports to try (default: 10)
 * @returns Promise<number> Next available port number
 * @throws Error if no available port found within maxAttempts
 */
export async function findAvailablePort(
  startPort: number, 
  host: string = '0.0.0.0', 
  maxAttempts: number = 10
): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port, host)) {
      return port;
    }
  }
  
  throw new Error(
    `No available port found in range ${startPort}-${startPort + maxAttempts - 1}. ` +
    'Please check for services using these ports or specify a different PORT in your environment.'
  );
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
  host: string = '0.0.0.0',
  enableAutoSelect: boolean = true
): Promise<{port: number, isPreferred: boolean, message?: string}> {
  
  // Check if preferred port is available
  if (await isPortAvailable(preferredPort, host)) {
    return {
      port: preferredPort,
      isPreferred: true
    };
  }
  
  // If auto-select is disabled, throw error
  if (!enableAutoSelect) {
    throw new Error(
      `Port ${preferredPort} is already in use. ` +
      'Please stop the service using this port or set a different PORT in your environment.'
    );
  }
  
  // Try to find an alternative port
  try {
    const availablePort = await findAvailablePort(preferredPort + 1, host);
    return {
      port: availablePort,
      isPreferred: false,
      message: `Port ${preferredPort} was in use, automatically selected port ${availablePort}`
    };
  } catch (error) {
    throw new Error(
      `Port ${preferredPort} is in use and no alternative ports are available. ` +
      'Please stop other services or choose a different port range.'
    );
  }
}