const shortterm = require('./shortterm');

module.exports = {
  read: () => {
    const data = shortterm.read();
    return data.identity || {};
  },
  write: (identity) => {
    const data = shortterm.read();
    data.identity = identity;
    shortterm.write(data);
  },
};
