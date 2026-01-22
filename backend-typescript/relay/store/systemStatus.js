function getSystemStatus() {
  return {
    id: 'status',
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    __typename: 'SystemStatus'
  };
}

module.exports = { getSystemStatus };
