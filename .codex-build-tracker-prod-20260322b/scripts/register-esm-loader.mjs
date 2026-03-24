import { register } from 'node:module';

/**
 * Register the ARCANOS ESM alias loader using Node's --import pathway.
 *
 * Purpose: preserve alias resolution without relying on deprecated --loader CLI usage.
 * Inputs/Outputs: resolves the existing loader relative to project root and installs it for this process.
 * Edge cases: throws if the loader module cannot be resolved or registration fails.
 */
function registerAliasLoader() {
  //audit assumption: this bootstrap file lives under /scripts; risk: moved file breaks relative URL; invariant: projectRootUrl resolves one level above /scripts; handling: derive project root from import.meta.url.
  const projectRootUrl = new URL('../', import.meta.url);
  register('./scripts/esm-alias-loader.mjs', projectRootUrl);
}

registerAliasLoader();
