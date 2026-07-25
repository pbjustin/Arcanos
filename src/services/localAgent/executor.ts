import type { ModuleHandlerContext } from '../moduleLoader.js';
import type {
  LocalAgentAction,
  LocalAgentActionInputMap
} from './contracts.js';

export interface LocalAgentExecutionRequest<
  TAction extends LocalAgentAction = LocalAgentAction
> {
  action: TAction;
  payload: LocalAgentActionInputMap[TAction];
  context: ModuleHandlerContext;
}

export type LocalAgentActionExecutor = (
  request: LocalAgentExecutionRequest
) => Promise<unknown>;

let configuredExecutor: LocalAgentActionExecutor | null = null;

export function configureLocalAgentActionExecutor(
  executor: LocalAgentActionExecutor | null
): void {
  configuredExecutor = executor;
}

export function getLocalAgentActionExecutor(): LocalAgentActionExecutor | null {
  return configuredExecutor;
}
