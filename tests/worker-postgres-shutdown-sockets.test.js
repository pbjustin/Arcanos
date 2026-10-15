import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function frame(kind, body) {
  const header = Buffer.alloc(5); header.write(kind); header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
async function within(pending, ms, code) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function withSyntheticWire(run) {
  const sockets = new Set(); const diagnostics = { queries: 0, unexpectedFrames: [] };
  const ready = frame('Z', Buffer.from('I')); const auth = Buffer.alloc(4);
  const columns = Buffer.alloc(2); columns.writeInt16BE(1);
  const columnMetadata = Buffer.alloc(18); columnMetadata.writeInt32BE(23, 6);
  columnMetadata.writeInt16BE(4, 10); columnMetadata.writeInt32BE(-1, 12);
  const row = Buffer.alloc(7); row.writeInt16BE(1); row.writeInt32BE(1, 2); row.write('1', 6);
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    let startup = true; let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const size = buffer.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (size < 4 || size > 4096) { diagnostics.unexpectedFrames.push('invalid-frame-length'); socket.destroy(); return; }
        if (buffer.length < size) return;
        const message = buffer.subarray(0, size); buffer = buffer.subarray(size);
        const kind = startup ? null : String.fromCharCode(message[0]);
        if (startup) { startup = false; socket.write(Buffer.concat([frame('R', auth), ready])); }
        else if (kind === 'Q' && message.subarray(5).toString('utf8') === 'SELECT 1\0') {
          diagnostics.queries += 1;
          socket.write(Buffer.concat([frame('T', Buffer.concat([columns, Buffer.from('?column?\0'), columnMetadata])),
            frame('D', row), frame('C', Buffer.from('SELECT 1\0')), ready]));
        } else if (kind === 'X') socket.end();
        else { diagnostics.unexpectedFrames.push('unexpected-query-or-frame'); socket.destroy(); return; }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { return await run(server.address().port, diagnostics); }
  finally { for (const socket of sockets) socket.destroy();
    await within(new Promise(resolve => server.close(resolve)), 1000, 'WORKER_PG_SOCKET_FIXTURE_SERVER_CLOSE_TIMEOUT'); }
}
async function childCase(port, mode) {
  const cwd = mkdtempSync(join(tmpdir(), 'arcanos-worker-pg-sockets-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/worker-pg-socket-child.mjs', import.meta.url)), String(port), mode], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    // The empty temporary cwd prevents dotenv from reading a checkout .env.
    // Both credentials are fictional and the target is this test's loopback socket.
    env: { NODE_ENV: 'test', DATABASE_URL: `postgresql://test-user:test-password@127.0.0.1:${port}/test` },
  });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let output = ''; let stderr = ''; let readyTimer;
  try {
    const evidence = await new Promise((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('WORKER_PG_SOCKET_FIXTURE_READY_TIMEOUT')), 3000);
      child.once('error', reject);
      child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 65536) child.kill('SIGTERM'); });
      child.stdout.on('data', chunk => {
        output += String(chunk); if (output.length > 65536) { reject(new Error('WORKER_PG_SOCKET_FIXTURE_OUTPUT_LIMIT')); return; }
        const match = /^WORKER_PG_SOCKET_READY (\{[^\r\n]+\})$/mu.exec(output);
        if (match) resolve(JSON.parse(match[1]));
      });
      void exited.then(() => { if (!output.includes('WORKER_PG_SOCKET_READY ')) reject(new Error(`WORKER_PG_SOCKET_FIXTURE_EXITED_EARLY: ${stderr}`)); });
    });
    clearTimeout(readyTimer);
    if (mode === 'close') await within(exited, 2000, 'WORKER_PG_SOCKET_FIXTURE_NATURAL_EXIT_TIMEOUT');
    else await new Promise(resolve => setTimeout(resolve, 350));
    return { evidence, stillAlive: child.exitCode === null && child.signalCode === null, exitCode: child.exitCode };
  } finally {
    clearTimeout(readyTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { await within(exited, 1000, 'WORKER_PG_SOCKET_FIXTURE_CHILD_STOP_TIMEOUT'); }
    catch { child.kill('SIGKILL'); await within(exited, 1000, 'WORKER_PG_SOCKET_FIXTURE_CHILD_KILL_TIMEOUT'); }
    rmdirSync(cwd);
  }
}
describe('normal Worker PostgreSQL pool socket shutdown component', () => {
  it('retains two real sockets without close and exits naturally through the existing global close API', async () => {
    expect(existsSync(new URL('../dist/core/db/client.js', import.meta.url))).toBe(true);
    await withSyntheticWire(async (port, diagnostics) => {
      const retained = await childCase(port, 'retain');
      expect(retained.evidence).toEqual({ total: 2, idle: 2, minimum: 2, allowExitOnIdle: false, idleTimeoutMillis: 30000 });
      expect(retained.stillAlive).toBe(true);
      const closed = await childCase(port, 'close');
      expect(closed.evidence).toEqual(retained.evidence);
      expect(closed.stillAlive).toBe(false); expect(closed.exitCode).toBe(0);
      expect(diagnostics).toEqual({ queries: 2, unexpectedFrames: [] });
    });
  }, 10_000);
});
