import { afterEach, describe, expect, it } from '@jest/globals';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.join(process.cwd(), 'scripts/validate-tutor-pilot-package.mjs');
const source = path.join(process.cwd(), 'integrations/tutor-pilot');
const temporaryRoots: string[] = [];

function copyPackage(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-package-'));
  temporaryRoots.push(root);
  cpSync(source, root, { recursive: true });
  return root;
}

function validate(root = source, args: string[] = []) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    // Each absolute path comes directly from mkdtemp, inside the intended temporary parent.
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-package-')) {
      throw new Error('Unexpected temporary test path');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Tutor package release boundary', () => {
  it('validates the portable schema and reports only reviewed distribution candidates', () => {
    const result = validate();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.sourceValidation).toBe('PASS');
    expect(report.releaseStatus).toBe('BLOCKED');
    expect(report.archiveWritten).toBe(false);
    expect(report.distributionCandidates.map((item: { path: string }) => item.path)).toEqual([
      'plugin.json', 'skills/arcanos-tutor-pilot/SKILL.md'
    ]);
    expect(report.distributionCandidates.every((item: { sha256: string }) => /^[a-f0-9]{64}$/u.test(item.sha256))).toBe(true);
  });

  it('fails release mode without producing an installable artifact', () => {
    const result = validate(source, ['--release']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'RELEASE_BLOCKED', archiveWritten: false });
  });

  it('rejects invalid portable manifest fields through the actual schema', () => {
    const root = copyPackage();
    const file = path.join(root, 'plugin.json.template');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.arbitraryUnsupportedProperty = true;
    writeFileSync(file, JSON.stringify(manifest));
    expect(validate(root).status).toBe(1);
  });

  it('does not let a claimed app ID bypass registration review', () => {
    const root = copyPackage();
    const file = path.join(root, 'connection.requirements.json');
    const requirements = JSON.parse(readFileSync(file, 'utf8'));
    requirements.registeredAppId = 'unverified-registration';
    requirements.status = 'connected';
    writeFileSync(file, JSON.stringify(requirements));
    expect(validate(root, ['--release']).status).toBe(1);
  });

  it.each(['.env', 'private-builder-export.json', 'mcp.json', '.app.json', 'plugin.json'])('rejects unreviewed file %s', filename => {
    const root = copyPackage();
    writeFileSync(path.join(root, filename), '{}');
    expect(validate(root).status).toBe(1);
  });

  it('rejects credential-like material in an otherwise allowed file without logging it', () => {
    const root = copyPackage();
    const secret = `sk-proj-${'SYNTHETIC'.repeat(5)}`;
    writeFileSync(path.join(root, 'README.md'), secret);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
  });

  it('rejects a replaced permissive schema snapshot', () => {
    const root = copyPackage();
    writeFileSync(path.join(root, 'schemas/agent-plugins-1.0.0.schema.json'), '{}');
    expect(validate(root).status).toBe(1);
  });

  it('accepts the same official schema after a Windows CRLF checkout', () => {
    const root = copyPackage();
    const file = path.join(root, 'schemas/agent-plugins-1.0.0.schema.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/gu, '\r\n'));
    expect(validate(root).status).toBe(0);
  });

  it('rejects missing skill frontmatter and oversized packaged input', () => {
    const root = copyPackage();
    const file = path.join(root, 'skills/arcanos-tutor-pilot/SKILL.md');
    writeFileSync(file, 'No frontmatter');
    expect(validate(root).status).toBe(1);
    writeFileSync(file, 'x'.repeat(65 * 1024));
    expect(validate(root).status).toBe(1);
  });
});
