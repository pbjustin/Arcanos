const { createLogger, transports, format } = require('winston');

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.printf(info => `[${info.timestamp}] ${info.message}`)
  ),
  transports: [
    new transports.Console() // ✅ This ensures logs reach Railway's live stream
  ]
});

module.exports = logger;
