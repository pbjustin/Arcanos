const auditLogger = require('../modules/auditLogger');
const memory = require('../memory/middleware');
const fallbackChecker = require('../system/fallbackChecker'); // Adjust pathing as needed

let lastSnapshot = null;

module.exports = {
  enableAudit: () => {
    setInterval(() => {
      memory.read('audit_snapshot')
        .then(snapshot => {
          lastSnapshot = snapshot;
          console.log('Audit snapshot retrieved:', snapshot);
        });
    }, 60000); // Adjust timing if needed
  },

  auditEvent: (agent, action, meta) => {
    auditLogger.log(`${agent} performed: ${action}`, meta);
  },

  verifyFallback: () => {
    fallbackChecker.check()
      .then(result => {
        if (!result) {
          console.error('FALLBACK FAILURE: Rolling back...');
          memory.write('audit_snapshot', lastSnapshot); // Optional - rollback audit state
        }
      });
  }
};
