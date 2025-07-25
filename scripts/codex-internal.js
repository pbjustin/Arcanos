const fs = require('fs');
const path = require('path');
const Module = require('module');

/**
 * Mount ARCANOS runtime modules into Node's resolution paths for Codex.
 * Missing paths will generate warnings but will not throw errors.
 */
function mountArcanosInternal() {
  const root = path.resolve(__dirname, '..');
  const internalPaths = [
    path.join(root, 'dist'),
    path.join(root, 'src'),
    path.join(root, 'workers')
  ];

  internalPaths.forEach(p => {
    if (fs.existsSync(p)) {
      if (!Module.globalPaths.includes(p)) {
        Module.globalPaths.push(p);
      }
    } else {
      console.warn(`[CODEX-INTERNAL] Missing internal module path: ${p}`);
    }
  });
}

/**
 * Safe require helper with fallback logging if module is missing.
 */
function safeRequire(modulePath) {
  try {
    const resolved = path.isAbsolute(modulePath)
      ? modulePath
      : path.join(process.cwd(), modulePath);
    return require(resolved);
  } catch (err) {
    console.error(`[CODEX-INTERNAL] Failed to load module ${modulePath}: ${err.message}`);
    return {};
  }
}

mountArcanosInternal();

module.exports = { mountArcanosInternal, safeRequire };
