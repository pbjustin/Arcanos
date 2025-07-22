const shortterm = require('../modules/shortterm');

module.exports = async function fallbackLoader() {
  try {
    const state = await shortterm.read();
    return { success: true, state };
  } catch (err) {
    return { error: err.message };
  }
};
