const shortterm = require('./shortterm');

module.exports = {
  read: () => {
    const data = shortterm.read();
    return data.goals || [];
  },
  write: (goals) => {
    const data = shortterm.read();
    data.goals = goals;
    shortterm.write(data);
  },
};
