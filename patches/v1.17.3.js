// v1.17.3 Patch: Extended Self-Heal Parameters
// -------------------------------------------------

module.exports = {
    patchVersion: '1.17.3',

    // Restart behavior controls
    allowDynamicRestart: true,
    restartDelay: 5,           // Seconds to wait before restart
    restartTimeout: 30,        // Max seconds allowed for restart
    restartGracePeriod: 3,     // Seconds of grace before enforcing restart

    // Effects applied by this patch
    effects: [
        'improved fault isolation',
        'dynamic memory reallocation',
        'asynchronous event rollback'
    ]
}
