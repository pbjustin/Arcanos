const { exec } = require('child_process');

module.exports = {
  route: '/shell',
  description: 'Sandboxed shell executor',
  async handle(payload) {
    if (!payload.command) {
      throw new Error('Missing command');
    }

    return new Promise((resolve) => {
      exec(payload.command, { cwd: process.cwd(), timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          return resolve({
            command: payload.command,
            error: err.message,
            stderr: stderr.toString()
          });
        }

        resolve({
          command: payload.command,
          stdout: stdout.toString(),
          stderr: stderr.toString()
        });
      });
    });
  }
};
