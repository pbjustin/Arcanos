const clearCache = require('./memory/actions/clearCache');

module.exports = async function clearTemp() {
  clearCache();
  console.log('[CACHE CLEANER] Shortterm memory flushed');
};
