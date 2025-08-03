export async function getMemory() {
  return null;
}

export async function saveMemory(key, value) {
  return { key, value };
}

export async function storeMemory(key, value) {
  return saveMemory(key, value);
}

export async function writeMemory(key, payload) {
  return saveMemory(key, payload);
}

export async function indexMemory(indexKey, targetKey) {
  return { indexKey, targetKey };
}

export default {
  getMemory,
  saveMemory,
  storeMemory,
  writeMemory,
  indexMemory
};
