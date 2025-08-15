// Basic logger utility used for audit and debug output
function info(msg) {
  console.log(`[INFO] ${msg}`);
}

function warn(msg) {
  console.warn(`[WARN] ${msg}`);
}

function error(msg) {
  console.error(`[ERROR] ${msg}`);
}

module.exports = { info, warn, error };
