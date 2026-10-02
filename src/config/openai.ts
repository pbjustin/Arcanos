// Resolve lazily so importing routes does not require an available authority.
// Both legacy entry points share the service's configured final model policy.
export {
  getDefaultModel as getConfiguredModel,
  getTrinityFinalModel as getConfiguredFineTune
} from '@services/openai/credentialProvider.js';
