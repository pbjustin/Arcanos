// Convenience wrapper for the compiled Codex integrator
try {
  module.exports = require('./dist/codex-integrator');
} catch (err) {
  // Fallback to TypeScript source for development environments
  module.exports = require('./src/codex-integrator');
}
