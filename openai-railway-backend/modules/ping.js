module.exports = {
  route: '/ping',
  description: 'Simple ping response',
  async handler() {
    return { pong: true, timestamp: Date.now() };
  }
};
