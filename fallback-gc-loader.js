try {
  if (!global.gc) {
    console.warn("\u26a0\ufe0f GC not exposed. Attempting to re-run with --expose-gc...");
    const { spawn } = require('child_process');
    spawn(process.execPath, ['--expose-gc', ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, GC_RELOADED: '1' }
    });
    process.exit(0);
  } else {
    console.log("\u2705 GC is available.");
  }
} catch (err) {
  console.error("\ud83d\udea8 Failed to re-initialize with --expose-gc:", err);
}
