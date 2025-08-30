const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, 'modules');

module.exports = {
  async dispatch(moduleName, payload) {
    try {
      const mod = require(path.join(MODULES_DIR, moduleName));
      const handler = mod.handle || mod.handler;
      if (typeof handler !== 'function') {
        throw new Error('Module missing handler');
      }
      return await handler(payload);
    } catch (err) {
      throw new Error(`Module ${moduleName} not found or failed: ${err.message}`);
    }
  },
  registry() {
    return fs.readdirSync(MODULES_DIR)
      .filter(f => f.endsWith('.js'))
      .reduce((acc, file) => {
        const name = path.basename(file, '.js');
        acc[name] = `modules/${file}`;
        return acc;
      }, {});
  }
};
