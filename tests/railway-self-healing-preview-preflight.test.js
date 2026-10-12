import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { METADATA_QUERIES, readProjectIdentifiers, readTrustedCheckout,
  runSelfHealingPreviewPreflight, writePreflightReport } from '../scripts/railway-self-healing-preview-preflight.mjs';
import { SELF_HEALING_PREVIEW_PROFILE as PROFILE } from '../scripts/railway-self-healing-preview-profile.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HEAD = 'a'.repeat(40), CONTROLLER = 'b'.repeat(40), BASE = 'c'.repeat(40);
const NOW = '2026-10-12T14:00:00.000Z';
const PRODUCTION = 'fb583147-6c39-4343-9267-500f357d25ab';
const id = number => `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`;
const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temp() { const directory = mkdtempSync(path.join(os.tmpdir(), 'self-healing-preflight-test-')); temporary.push(directory); return directory; }
function fixture() {
  const directory = temp();
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: PROFILE.repository, GITHUB_WORKFLOW_REF:
      'pbjustin/Arcanos/.github/workflows/railway-self-healing-preview-preflight.yml@refs/heads/main',
    GITHUB_ACTOR: 'pbjustin', GITHUB_TRIGGERING_ACTOR: 'pbjustin', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '12345', GITHUB_WORKFLOW_SHA: CONTROLLER, GITHUB_WORKSPACE: ROOT,
    PR_NUMBER: '1539', EXPECTED_SHA: HEAD, RUNNER_TEMP: directory,
    PREFLIGHT_OUTPUT_PATH: path.join(directory, 'railway-self-healing-preview-preflight.json'),
    GITHUB_TOKEN: 'private-github-token-sentinel', RAILWAY_API_TOKEN: 'private-railway-token-sentinel', PATH: process.env.PATH };
  const pull = { number: 1539, state: 'open', draft: false, labels: [],
    base: { ref: 'main', sha: BASE, repo: { full_name: PROFILE.repository } },
    head: { ref: 'codex/targeted-security-healing-20261012', sha: HEAD, repo: { full_name: PROFILE.repository } } };
  const calls = [];
  const connection = values => ({ edges: values.map(value => ({ node: { id: value, projectId: PROFILE.projectId } })),
    pageInfo: { hasNextPage: false, endCursor: null } });
  const dependencies = { readCheckout: () => ({ sha: CONTROLLER, clean: true }), now: () => NOW,
    github: { readPullRequest: async () => { calls.push('pull'); return structuredClone(pull); } },
    railway: new Proxy({
      validateAuthority: async options => { calls.push('authority'); expect(options).toEqual({ requireNativeDisabled: false }); },
      listEnvironments: async () => { calls.push('environments'); return [{ id: PRODUCTION, name: 'production', projectId: PROFILE.projectId }]; },
      graphql: async (query, variables) => {
        expect(query).toMatch(/^query /u); expect(query).not.toMatch(/mutation|decryptVariables|config\s*\(/iu);
        expect(variables.projectId).toBe(PROFILE.projectId);
        const kind = query.includes('services(') ? 'services' : 'volumes'; calls.push(kind);
        return { project: { id: PROFILE.projectId, [kind]: connection([id(kind === 'services' ? 1 : 2)]) } };
      },
    }, { get(target, key) { if (!Object.hasOwn(target, key)) throw new Error('Mutation or unexpected capability accessed'); return target[key]; } }),
  };
  return { env, pull, calls, connection, dependencies };
}

describe('owner-run read-only self-healing preview preflight', () => {
  it('collects metadata only, refreshes the exact PR and retains a blocked plan without mutation capabilities', async () => {
    const f = fixture(); const report = await runSelfHealingPreviewPreflight(f.env, f.dependencies);
    expect(f.calls).toEqual(['pull', 'authority', 'environments', 'services', 'volumes', 'pull']);
    expect(report.code).toBe('SELF_HEALING_PREVIEW_PREFLIGHT_PLAN_ONLY');
    expect(report.plan.preexistingServiceIds).toEqual([id(1)]); expect(report.plan.preexistingVolumeIds).toEqual([id(2)]);
    expect(report.identity.controllerCommit).toBe(CONTROLLER); expect(report.plan.sourceEnvironmentId).toBeNull();
    expect(report.identity.baseCommit).toBe(BASE);
    expect(report).toMatchObject({ status: 'BLOCKED', liveAcceptance: 'BLOCKED', deploymentPerformed: false,
      provisioningImplemented: false, runtimeSupervisorImplemented: false, ownerInstallationPerformed: false,
      provisioningExecutionPerformed: false, previewIsolationVerified: false, selfHealingRuntimeAcceptanceSupported: false });
    expect(JSON.stringify(report)).not.toMatch(/private-(github|railway)-token-sentinel/u);
  });

  it.each([
    ['GITHUB_ACTOR', 'someone-else'], ['GITHUB_TRIGGERING_ACTOR', 'someone-else'],
    ['GITHUB_EVENT_NAME', 'pull_request_target'], ['GITHUB_REF', 'refs/heads/codex/candidate'],
    ['GITHUB_REPOSITORY', 'other/Arcanos'], ['GITHUB_ACTIONS', 'false'], ['GITHUB_RUN_ATTEMPT', '2'],
    ['GITHUB_WORKFLOW_REF', 'pbjustin/Arcanos/.github/workflows/railway-self-healing-preview-preflight.yml@refs/heads/candidate'],
    ['EXPECTED_SHA', 'not-a-sha'], ['PR_NUMBER', '1539; echo private-sentinel'],
  ])('rejects incorrect %s before credentials or APIs are used', async (key, value) => {
    const f = fixture(); f.env[key] = value;
    const report = await runSelfHealingPreviewPreflight(f.env, f.dependencies);
    expect(report.plan).toBeNull(); expect(f.calls).toEqual([]); expect(report.code).not.toBe('SELF_HEALING_PREVIEW_PREFLIGHT_PLAN_ONLY');
  });

  it.each([{ sha: HEAD, clean: true }, { sha: CONTROLLER, clean: false }])('rejects an untrusted or dirty checkout', async checkout => {
    const f = fixture(); f.dependencies.readCheckout = () => checkout;
    expect((await runSelfHealingPreviewPreflight(f.env, f.dependencies)).code).toBe('SELF_HEALING_PREVIEW_PREFLIGHT_CHECKOUT_INVALID');
    expect(f.calls).toEqual([]);
  });

  it('passes no tokens to either Git subprocess', () => {
    const f = fixture(), observed = [];
    const result = readTrustedCheckout(f.env, (command, args, options) => { observed.push({ command, args, options }); return args[0] === 'rev-parse' ? CONTROLLER : ''; });
    expect(result).toEqual({ sha: CONTROLLER, clean: true });
    for (const { command, args, options } of observed) {
      expect(command).toBe('git'); expect(args[0]).not.toBe('checkout');
      expect(Object.keys(options.env).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH']);
      expect(JSON.stringify(options.env)).not.toContain('private-');
    }
  });

  it.each(['head', 'base', 'branch', 'closed'])('rejects %s drift after inventory collection', async kind => {
    const f = fixture(); let reads = 0;
    f.dependencies.github.readPullRequest = async () => { const pull = structuredClone(f.pull);
      if (++reads === 2) { if (kind === 'head') pull.head.sha = 'd'.repeat(40);
        else if (kind === 'base') pull.base.sha = 'd'.repeat(40);
        else if (kind === 'branch') pull.head.ref = 'codex/changed'; else pull.state = 'closed'; }
      return pull; };
    const report = await runSelfHealingPreviewPreflight(f.env, f.dependencies);
    expect(reads).toBe(2); expect(report.plan).toBeNull(); expect(report.code).toBe('SELF_HEALING_PREVIEW_PR_HEAD_MISMATCH');
  });

  it.each(['initial-missing', 'initial-malformed', 'end-missing', 'end-malformed'])('rejects %s base identity', async scenario => {
    const f = fixture(); let reads = 0;
    f.dependencies.github.readPullRequest = async () => { reads++; const pull = structuredClone(f.pull);
      if (reads === (scenario.startsWith('initial') ? 1 : 2)) pull.base.sha = scenario.endsWith('missing') ? undefined : 'invalid';
      return pull; };
    const report = await runSelfHealingPreviewPreflight(f.env, f.dependencies);
    expect(report.code).toBe('SELF_HEALING_PREVIEW_PR_HEAD_MISMATCH'); expect(report.plan).toBeNull();
  });

  it('rejects a private backend error without returning its message, URL or token', async () => {
    const f = fixture(); f.dependencies.railway = { validateAuthority: async () => { throw new Error('PRIVATE_SECRET_SENTINEL https://host/?token=hidden'); } };
    const report = await runSelfHealingPreviewPreflight(f.env, f.dependencies);
    expect(report.code).toBe('SELF_HEALING_PREVIEW_PREFLIGHT_READ_FAILED'); expect(JSON.stringify(report)).not.toMatch(/PRIVATE_SECRET|hidden|host/u);
  });

  it('rejects a scan exceeding its bounded duration instead of refreshing its inventory timestamp', async () => {
    const f = fixture(); let clock = 0;
    f.dependencies.now = () => new Date(Date.parse(NOW) + clock).toISOString();
    f.dependencies.railway = { validateAuthority: async () => { clock = 55_001; } };
    expect((await runSelfHealingPreviewPreflight(f.env, f.dependencies)).code).toBe('SELF_HEALING_PREVIEW_PREFLIGHT_TIMEOUT');
  });

  it('reads all project resource pages without changing static query operations', async () => {
    const f = fixture(), afters = [];
    const railway = { graphql: async (query, variables) => { expect(query).toBe(METADATA_QUERIES.volumes); afters.push(variables.after);
      const page = f.connection([id(afters.length)]); if (afters.length === 1) page.pageInfo = { hasNextPage: true, endCursor: 'next' };
      return { project: { id: PROFILE.projectId, volumes: page } }; } };
    expect(await readProjectIdentifiers(railway, 'volumes')).toEqual([id(1), id(2)]); expect(afters).toEqual([null, 'next']);
  });

  it.each(['duplicate', 'cursor-cycle', 'partial', 'foreign-project', 'missing-cursor'])('rejects %s inventory instead of claiming completeness', async kind => {
    const f = fixture(); let reads = 0;
    const railway = { graphql: async () => { reads++; const page = f.connection(kind === 'duplicate' ? [id(1), id(1)] : [id(reads)]);
      const project = { id: PROFILE.projectId, services: page };
      if (kind === 'foreign-project') project.id = id(9);
      if (kind === 'cursor-cycle' || kind === 'partial' || kind === 'missing-cursor') page.pageInfo = {
        hasNextPage: true, endCursor: kind === 'missing-cursor' ? null : kind === 'cursor-cycle' ? 'same' : `page-${reads}` };
      return { project }; } };
    await expect(readProjectIdentifiers(railway, 'services')).rejects.toMatchObject({ code: 'SELF_HEALING_PREVIEW_PREFLIGHT_INVENTORY_INVALID' });
    expect(reads).toBeLessThanOrEqual(20);
  });

  it('writes only a new direct 0600 receipt and rejects existing symlinks before API use', async () => {
    const f = fixture(); const report = await runSelfHealingPreviewPreflight(f.env, f.dependencies);
    writePreflightReport(f.env, report); expect(statSync(f.env.PREFLIGHT_OUTPUT_PATH).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f.env.PREFLIGHT_OUTPUT_PATH, 'utf8')).liveAcceptance).toBe('BLOCKED');
    const g = fixture(), target = path.join(g.env.RUNNER_TEMP, 'untouched'); writeFileSync(target, 'owner data');
    symlinkSync(target, g.env.PREFLIGHT_OUTPUT_PATH);
    expect((await runSelfHealingPreviewPreflight(g.env, g.dependencies)).plan).toBeNull(); expect(g.calls).toEqual([]);
    expect(() => writePreflightReport(g.env, report)).toThrow(); expect(readFileSync(target, 'utf8')).toBe('owner data');
  });

  it('rejects an output outside runner temp before API use', async () => {
    const f = fixture(); f.env.PREFLIGHT_OUTPUT_PATH = path.join(os.tmpdir(), 'outside-preflight.json');
    const report = await runSelfHealingPreviewPreflight(f.env, f.dependencies);
    expect(report.code).toBe('SELF_HEALING_PREVIEW_PREFLIGHT_OUTPUT_INVALID'); expect(f.calls).toEqual([]);
  });

  it('CLI retains a sanitized blocked artifact on invalid owner context without network calls', () => {
    const f = fixture(); f.env.GITHUB_ACTOR = 'someone-else';
    f.env.GITHUB_OUTPUT = path.join(f.env.RUNNER_TEMP, 'github-output'); writeFileSync(f.env.GITHUB_OUTPUT, '');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/railway-self-healing-preview-preflight.mjs')], {
      env: f.env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1); expect(result.stderr).toBe(''); expect(result.stdout).not.toContain('private-');
    const report = JSON.parse(readFileSync(f.env.PREFLIGHT_OUTPUT_PATH, 'utf8'));
    expect(report.code).toBe('SELF_HEALING_PREVIEW_PREFLIGHT_PROVENANCE_INVALID'); expect(report.deploymentPerformed).toBe(false);
    expect(readFileSync(f.env.GITHUB_OUTPUT, 'utf8')).toBe('artifact_ready=true\n');
  });

  it('CLI never authorizes upload of a preexisting symlinked artifact', () => {
    const f = fixture(); f.env.GITHUB_ACTOR = 'someone-else';
    f.env.GITHUB_OUTPUT = path.join(f.env.RUNNER_TEMP, 'github-output'); writeFileSync(f.env.GITHUB_OUTPUT, '');
    const target = path.join(f.env.RUNNER_TEMP, 'private-owner-data'); writeFileSync(target, 'private-sentinel');
    symlinkSync(target, f.env.PREFLIGHT_OUTPUT_PATH);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/railway-self-healing-preview-preflight.mjs')], {
      env: f.env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1); expect(result.stdout).not.toContain('private-sentinel');
    expect(readFileSync(f.env.GITHUB_OUTPUT, 'utf8')).toBe(''); expect(readFileSync(target, 'utf8')).toBe('private-sentinel');
  });

  it('workflow exposes only an owner/main manual metadata job with trusted checkout and no write permission', () => {
    const workflow = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/railway-self-healing-preview-preflight.yml'), 'utf8'));
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']); expect(Object.keys(workflow.jobs)).toEqual(['preflight']);
    const job = workflow.jobs.preflight;
    expect(job.if).toContain("github.actor == 'pbjustin'"); expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe('railway-pr-preview-lifecycle'); expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(job.steps[0].with).toEqual({ ref: '${{ github.workflow_sha }}', 'persist-credentials': false });
    const run = job.steps.find(step => step.run); expect(run.run).toBe('node scripts/railway-self-healing-preview-preflight.mjs');
    expect(run.env.RAILWAY_API_TOKEN).toBe('${{ secrets.RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN }}');
    expect(job.steps.at(-1).if).toBe("always() && steps.preflight.outputs.artifact_ready == 'true'");
    expect(job['timeout-minutes']).toBe(5);
  });
});
