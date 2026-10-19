import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('inherited Linux kernel boundary denies outbound effects and permits inbound replies', {
  skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 15_000,
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gaming-network-'));
  const binary = path.join(directory, 'network-deny');
  let server;
  try {
    const compile = spawnSync('gcc', ['-static', '-O2', '-Wall', '-Wextra', '-Werror',
      fileURLToPath(new URL('./gaming-preview-network.c', import.meta.url)), '-o', binary], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    // These are numeric documentation addresses. The filter returns EPERM
    // before routing, DNS, a TCP packet or a provider request can happen.
    const probe = spawnSync(binary, [process.execPath, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import dgram from 'node:dgram';
      import dns from 'node:dns/promises';
      import { spawnSync } from 'node:child_process';
      const attempt = host => new Promise((resolve, reject) => {
        const socket = net.connect({host, port:9});
        socket.once('connect', () => { socket.destroy(); reject(new Error('OUTBOUND_ALLOWED')); });
        socket.once('error', error => { assert.equal(error.code, 'EPERM'); resolve(); });
      });
      await attempt('192.0.2.1'); await attempt('2001:db8::1');
      await new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', error => { assert.equal(error.code, 'EPERM'); socket.close(); resolve(); });
        socket.send('denied', 9, '192.0.2.1', error => {
          if (error) { assert.equal(error.code, 'EPERM'); socket.close(); resolve(); }
          else reject(new Error('DATAGRAM_ALLOWED'));
        });
      });
      await assert.rejects(dns.resolve4('gaming-egress-test.invalid'));
      const inherited = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import net from 'node:net'; const s=net.connect(9,'192.0.2.1'); s.on('connect',()=>process.exit(7)); s.on('error',e=>process.exit(e.code==='EPERM'?0:8));"], {timeout:2000});
      assert.equal(inherited.status, 0);
    `], { encoding: 'utf8', timeout: 8_000 });
    assert.equal(probe.status, 0, `${probe.stderr}\n${probe.stdout}`);
    assert.match(probe.stderr, /GAMING_PREVIEW_KERNEL_NETWORK_BOUNDARY=ENFORCED/);
    server = spawn(binary, [process.execPath, '--input-type=module', '-e', `
      import http from 'node:http';
      const server=http.createServer((req,res)=>res.end('kernel-boundary-inbound-ok'));
      server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.stdout.once('data', bytes => resolve(Number(bytes.toString().trim())));
      server.once('exit', code => reject(new Error(`Listener exited ${code}`)));
    });
    assert.ok(Number.isSafeInteger(port) && port > 0);
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(await response.text(), 'kernel-boundary-inbound-ok');
  } finally {
    if (server) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
    rmSync(directory, { recursive: true, force: true });
  }
});
