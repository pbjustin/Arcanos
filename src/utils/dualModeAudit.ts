export interface DualModeAuditOptions {
  /** run in simulation mode instead of hitting backend */
  simulate?: boolean;
  /** override backend registry base url */
  backendRegistry?: string;
  /** custom fetch implementation for backend mode */
  fetcher?: typeof fetch;
  /** optional list of modules considered present in simulation mode */
  simulatedRegistry?: string[];
}

export interface DualModeAuditBaseResult {
  timestamp: string;
  mode: 'backend' | 'simulation';
  module: string;
  exists: boolean;
  fallback_used: boolean;
  interference: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Performs a dual-mode audit against a backend registry or via local simulation.
 *
 * Backend mode will call a real HTTP endpoint to verify the module, while
 * simulation mode uses a deterministic in-memory registry to emulate the result
 * without invoking any AI models. The function is designed to be easily
 * reusable and testable by allowing dependency injection of the fetch
 * implementation and simulated registry.
 *
 * @param moduleName Name of the module to audit
 * @param options Optional configuration for the audit
 */
export async function dualModeAudit(
  moduleName: string,
  options: DualModeAuditOptions = {}
): Promise<DualModeAuditBaseResult> {
  const {
    simulate = false,
    backendRegistry = process.env.BACKEND_REGISTRY_URL ||
      'https://your-real-service.com/registry',
    fetcher = fetch,
    simulatedRegistry = []
  } = options;

  const timestamp = new Date().toISOString();

  if (!simulate) {
    try {
      const res = await fetcher(`${backendRegistry}/${encodeURIComponent(moduleName)}`);
      if (!res.ok) {
        return {
          timestamp,
          mode: 'backend',
          module: moduleName,
          exists: false,
          fallback_used: false,
          interference: false,
          error: `HTTP ${res.status}`
        };
      }

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        console.warn('Failed to parse JSON response, using empty object');
      }
      return {
        timestamp,
        mode: 'backend',
        module: moduleName,
        exists: Boolean(data.exists),
        fallback_used: false,
        interference: false
      };
    } catch (err: any) {
      return {
        timestamp,
        mode: 'backend',
        module: moduleName,
        exists: false,
        fallback_used: false,
        interference: false,
        error: err?.message || String(err)
      };
    }
  }

  // Simulation mode: deterministic local registry check to avoid hallucinations
  const registry = new Set(simulatedRegistry);
  return {
    timestamp,
    mode: 'simulation',
    module: moduleName,
    exists: registry.has(moduleName),
    fallback_used: true,
    interference: false
  };
}

export default dualModeAudit;
