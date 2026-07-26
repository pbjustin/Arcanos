import { routeOperatorCommandThroughDispatch } from '@services/gptAccessNaturalLanguageDispatch.js';
import {
  configureArcanosCoreOperatorDispatch,
  type ArcanosCoreOperatorDispatcher,
} from '@services/arcanosCoreOperatorDispatchPort.js';

const defaultOperatorDispatcher: ArcanosCoreOperatorDispatcher =
  routeOperatorCommandThroughDispatch;

export function configureDefaultArcanosCoreRuntimeProviders(): void {
  configureArcanosCoreOperatorDispatch(defaultOperatorDispatcher);
}
