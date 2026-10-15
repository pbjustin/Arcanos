import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync('.github/workflows/ci-cd.yml', 'utf8'));
const step = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
  .find(candidate => candidate.env?.EVIDENCE_HEAD_SHA && candidate.run?.includes('jest-counts.json'));
const source = step.run.split("<<'NODE'\n")[1].split('\nNODE')[0];

function receipt(kind) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-jest-provenance-'));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
    EVIDENCE_TEST_TYPE: 'unit' };
  const git = (args, input) => execFileSync('git', ['-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`, ...args], { cwd: directory, env,
    input, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  try {
    git(['init', '--quiet']);
    const tree = content => {
      const blob = git(['hash-object', '-w', '--stdin'], content);
      return git(['mktree'], `100644 blob ${blob}\tfixture.txt\n`);
    };
    const headTree = tree('head');
    const headSha = git(['commit-tree', headTree], 'head\n');
    const testedTree = kind === 'different' ? tree('merge differs') : headTree;
    const testedSha = git(['commit-tree', testedTree, '-p', headSha], 'tested merge\n');
    git(['update-ref', 'HEAD', testedSha]);
    env.EVIDENCE_HEAD_SHA = kind === 'unavailable' ? 'f'.repeat(40) : headSha;
    writeFileSync(path.join(directory, 'jest-result.json'), JSON.stringify({ success: true,
      numPassedTests: 7, numFailedTests: 0, numTotalTests: 7 }));
    const child = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: directory, env, input: source, encoding: 'utf8', timeout: 5000, windowsHide: true });
    expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
      status: 0, error: undefined, stderr: '' });
    return { counts: JSON.parse(readFileSync(path.join(directory, 'jest-counts.json'), 'utf8')),
      headSha, testedSha, headTree, testedTree };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('CI Jest counter checkout provenance', () => {
  it('independently records a merge checkout and proves equal source trees', () => {
    const value = receipt('equal');
    expect(value.headSha).not.toBe(value.testedSha);
    expect(value.counts).toMatchObject({ headSha: value.headSha, testedSha: value.testedSha,
      testedTree: value.testedTree, headTree: value.headTree, exactHeadTree: true,
      success: true, numPassedTests: 7 });
  });
  it('retains counters but refuses exact-head attribution for a different merge tree', () => {
    const value = receipt('different');
    expect(value.counts).toMatchObject({ testedSha: value.testedSha,
      testedTree: value.testedTree, headTree: value.headTree, exactHeadTree: false,
      success: true, numPassedTests: 7 });
  });
  it('does not infer provenance when the head commit object is unavailable', () => {
    const value = receipt('unavailable');
    expect(value.counts).toMatchObject({ testedSha: value.testedSha,
      testedTree: value.testedTree, headTree: null, exactHeadTree: false });
  });
});
