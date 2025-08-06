// Convenience wrapper for the compiled Codex integrator
let codexIntegrator;
try {
  const module = await import('./dist/codex-integrator.js');
  codexIntegrator = module;
} catch (err) {
  // Fallback to TypeScript source for development environments
  const module = await import('./src/codex-integrator.js');
  codexIntegrator = module;
}

export default codexIntegrator;
