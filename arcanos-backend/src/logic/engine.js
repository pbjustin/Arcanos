module.exports = function processQuery(query) {
  if (query === 'status') return { status: 'OK', timestamp: Date.now() };
  if (query === 'clear') return { clarity: 9, leverage: 8, efficiency: 7 };
  return { error: 'Unrecognized input' };
};
