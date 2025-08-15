const crypto = require('crypto');

// Simple root token verification using timing safe comparison
function verifyRootToken(token) {
  const rootToken = process.env.ROOT_TOKEN || 'default-root-token';
  const tokenBuffer = Buffer.from(token || '', 'utf8');
  const rootBuffer = Buffer.from(rootToken, 'utf8');
  if (tokenBuffer.length !== rootBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(tokenBuffer, rootBuffer);
}

module.exports = { verifyRootToken };
