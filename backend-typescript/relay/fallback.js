const { randomUUID } = require('crypto');

function buildFallbackResponse(reason, detail) {
  return {
    ok: false,
    fallback: true,
    reason,
    detail: detail || null,
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    meta: {
      retryable: false
    }
  };
}

module.exports = { buildFallbackResponse };
