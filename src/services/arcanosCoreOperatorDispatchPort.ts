/**
 * Dependency-neutral port for ARCANOS:CORE operator-command routing.
 *
 * The core writing module depends only on this narrow contract. Runtime
 * composition supplies the GPT Access dispatcher so control-plane services do
 * not become dependencies of the core module itself.
 */

export interface ArcanosCoreOperatorDispatchInput {
  utterance: string;
  context?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface ArcanosCoreOperatorDispatchResult {
  statusCode: number;
  payload: unknown;
  plan: {
    action: string;
    source: string;
  };
  policy: {
    status: string;
  };
}

export type ArcanosCoreOperatorDispatcher = (
  input: ArcanosCoreOperatorDispatchInput
) => Promise<ArcanosCoreOperatorDispatchResult | null>;

export class ArcanosCoreOperatorDispatchNotConfiguredError extends Error {
  readonly code = 'ARCANOS_CORE_OPERATOR_DISPATCH_NOT_CONFIGURED';

  constructor() {
    super('ARCANOS:CORE operator dispatch is not configured.');
    this.name = 'ArcanosCoreOperatorDispatchNotConfiguredError';
  }
}

let configuredDispatcher: ArcanosCoreOperatorDispatcher | null = null;

export function configureArcanosCoreOperatorDispatch(
  dispatcher: ArcanosCoreOperatorDispatcher | null
): void {
  configuredDispatcher = dispatcher;
}

export function getArcanosCoreOperatorDispatch(): ArcanosCoreOperatorDispatcher {
  if (!configuredDispatcher) {
    throw new ArcanosCoreOperatorDispatchNotConfiguredError();
  }
  return configuredDispatcher;
}

export function isArcanosCoreOperatorDispatchConfigured(): boolean {
  return configuredDispatcher !== null;
}
