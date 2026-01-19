const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODULES_DIR = path.resolve(__dirname, '..', '..', 'modules');
const MANIFEST_PATH = path.join(MODULES_DIR, 'manifest.json');

function loadManifest() {
  const content = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(content);
  if (!manifest || !Array.isArray(manifest.modules)) {
    throw new Error('Invalid modules manifest');
  }
  return manifest;
}

function loadModuleFile(relativePath) {
  const fullPath = path.resolve(MODULES_DIR, relativePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  return JSON.parse(content);
}

function getModules() {
  const manifest = loadManifest();
  return manifest.modules.map((entry) => {
    const moduleData = loadModuleFile(entry.path);
    return {
      ...moduleData,
      __typename: 'Module'
    };
  });
}

function getModuleById(id) {
  const modules = getModules();
  return modules.find((module) => module.id === id) || null;
}

function getModulesHash() {
  const manifest = loadManifest();
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(manifest));

  const sorted = [...manifest.modules].sort((a, b) => a.id.localeCompare(b.id));
  for (const entry of sorted) {
    const moduleData = loadModuleFile(entry.path);
    hash.update(entry.path);
    hash.update(JSON.stringify(moduleData));
  }

  return hash.digest('hex');
}

module.exports = {
  MODULES_DIR,
  MANIFEST_PATH,
  loadManifest,
  loadModuleFile,
  getModules,
  getModuleById,
  getModulesHash
};
