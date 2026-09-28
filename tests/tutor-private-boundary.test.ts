import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
const script = path.resolve('scripts/check-tutor-private-boundary.mjs');
const instruction = 'Synthetic private teaching sentinel for boundary tests only, never a real Builder instruction.';
const behavior = 'Synthetic private expected behavior sentinel that must remain in the ignored input directory.';
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tutor-private-boundary-'));
  roots.push(root);
  const input = path.join(root, '.local-migration/arcanos-tutor');
  mkdirSync(input, { recursive: true });
  spawnSync('git', ['init', '--quiet', root]);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  writeFileSync(path.join(input, 'published-gpt.json'), JSON.stringify({ instructions: instruction, representativeBehavior: [behavior] }));
  const run = () => spawnSync(process.execPath, [script, '--inputs', input], { encoding: 'utf8' });
  return { root, input, run };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('tutor-private-boundary-')) throw new Error('Invalid test cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
describe('Private Tutor source Git boundary', () => {
  it('accepts private ignored inputs and prints only safe counts', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ privacyBoundary: 'PASS', privateInputTracked: false });
    expect(result.stdout).not.toContain(instruction);
  });
  it.each([instruction, behavior])('rejects source text copied outside ignored inputs', value => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'unsafe.md'), value);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(value);
  });
  it('checks staged bytes even when working bytes have been replaced with safe text', () => {
    const f = fixture();
    const file = path.join(f.root, 'review.md');
    writeFileSync(file, instruction);
    expect(spawnSync('git', ['-C', f.root, 'add', 'review.md']).status).toBe(0);
    writeFileSync(file, 'Safe working copy does not erase a staged leak.');
    expect(f.run().status).toBe(1);
  });
  it('rejects force-added private inputs despite the ignore rule', () => {
    const f = fixture();
    expect(spawnSync('git', ['-C', f.root, 'add', '-f', '.local-migration/arcanos-tutor/published-gpt.json']).status).toBe(0);
    expect(f.run().status).toBe(1);
  });
  it('rejects missing ignore protection', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, '.gitignore'), 'unrelated/\n');
    expect(f.run().status).toBe(1);
  });
});
