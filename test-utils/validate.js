const { execSync } = require('child_process');

function validateSyntax(file) {
  try {
    execSync(`node --check ${file}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    console.error(`❌ Syntax error in ${file}:`, err.message);
    return false;
  }
}

module.exports = { validateSyntax };
