const express = require('express');
const router = express.Router();
const os = require('os');
const { getErrorCount } = require('../utils/logger');

router.get('/', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    route: '/status',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    errors: { recent: getErrorCount() },
  });
});

module.exports = router;