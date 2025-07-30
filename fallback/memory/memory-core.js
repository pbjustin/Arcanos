module.exports = {
  async getMemory() {
    return null;
  },
  async saveMemory(key, value) {
    return { key, value };
  },
  storeMemory: async function(key, value) {
    return this.saveMemory(key, value);
  },
  writeMemory: async function(key, payload) {
    return this.saveMemory(key, payload);
  },
  indexMemory: async function(indexKey, targetKey) {
    return { indexKey, targetKey };
  }
};
