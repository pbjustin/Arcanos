const path = require('path');
const clearCache = require(path.resolve(__dirname, '../memory/actions/clearCache'));

module.exports = async function clearTemp() {
  clearCache();
  console.log('[CACHE CLEANER] Shortterm memory flushed');
};
