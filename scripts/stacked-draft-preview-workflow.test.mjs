import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../.github/workflows/railway-stacked-draft-preview.yml', import.meta.url), 'utf8'));
const policy = JSON.parse(readFileSync(new URL('../config/railway-stacked-draft-preview.json', import.meta.url), 'utf8'));
const SHA = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const IMAGE = `ghcr.io/pbjustin/arcanos-stacked-preview@sha256:${'c'.repeat(64)}`;
const allowedActions = new Set([
  'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
]);

const named = (job, name) => {
  const step = job.steps.find(value => value.name === name);
  assert.ok(step, `Missing reviewed step: ${name}`);
  return step;
};
const inline = step => {
  const match = /<<'NODE'\n([\s\S]+)\nNODE\s*$/u.exec(step.run);
  assert.ok(match, 'Expected an inline trusted Node program');
  return match[1];
};
const authorization = () => ({ version: 1, controllerSha: SHA, mainSha: 'd'.repeat(40),
  expiresAt: '2026-10-10T23:59:59.000Z', sourceArchiveSha256: 'e'.repeat(64),
  stack: [1533, 1534, 1535].map((prNumber, index) => ({ prNumber,
    headSha: String(index + 1).repeat(40), treeSha: String(index + 4).repeat(40) })) });
const baseEnvironment = directory => ({ PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
  EVENT_REPOSITORY: 'pbjustin/Arcanos', EVENT_ACTOR: 'pbjustin', EVENT_SENDER: 'pbjustin',
  EVENT_REF: 'refs/heads/main',
  EVENT_WORKFLOW_REF: 'pbjustin/Arcanos/.github/workflows/railway-stacked-draft-preview.yml@refs/heads/main',
  CONTROLLER_SHA: SHA, WORKFLOW_RUN_ID: '1234', WORKFLOW_RUN_ATTEMPT: '1', RUNNER_TEMP: directory,
  AUTHORIZATION_JSON: JSON.stringify(authorization()) });
const runInline = (step, directory, environment = {}) => spawnSync(process.execPath, ['--input-type=module'], {
  input: inline(step), cwd: directory, encoding: 'utf8', timeout: 5_000,
  env: { ...baseEnvironment(directory), ...environment },
});

test('stacked preview is owner-dispatched, disabled by default and separate from production admission', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs, { authorization_json: {
    description: 'Expiring exact-controller, exact-main, exact-stack authorization JSON', required: true, type: 'string',
  } });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: 'railway-stacked-draft-preview-pbjustin-Arcanos-1533-1534-1535', 'cancel-in-progress': false,
  });
  assert.equal(policy.enabled, false);
  assert.equal(policy.target, null);
  const authorize = workflow.jobs.authorize;
  for (const requirement of ["github.event_name == 'workflow_dispatch'", "github.repository == 'pbjustin/Arcanos'",
    "github.actor == 'pbjustin'", "github.event.sender.login == 'pbjustin'", "github.ref == 'refs/heads/main'",
    "github.workflow_ref == 'pbjustin/Arcanos/.github/workflows/railway-stacked-draft-preview.yml@refs/heads/main'"])
    assert.ok(authorize.if.includes(requirement), `Missing trust condition ${requirement}`);
  assert.deepEqual(authorize.permissions, { checks: 'read', contents: 'read', 'pull-requests': 'read' });
  const existing = readFileSync(new URL('./railway-pr-preview-lifecycle.mjs', import.meta.url), 'utf8');
  assert.match(existing, /&& !pullRequest\.draft/u);
  assert.match(existing, /&& pullRequest\.baseRef === CONTRACT\.baseBranch/u);
  assert.match(existing, /current\.draft === false/u);
  assert.doesNotMatch(JSON.stringify(workflow), /pull_request_target|OPENAI.*KEY|PRODUCTION.*TOKEN|promotion|plugin.*publish|gh pr merge/u);
});

test('dispatch rejects mismatched owners, workflow refs, replay and command-shaped source identities before checkout', () => {
  const step = workflow.jobs.authorize.steps[0];
  assert.equal(step.name, 'Validate owner dispatch before checkout');
  const variants = [
    {}, { EVENT_REPOSITORY: 'fork/Arcanos' }, { EVENT_ACTOR: 'contributor' }, { EVENT_SENDER: 'contributor' },
    { EVENT_REF: 'refs/heads/codex/preview' },
    { EVENT_WORKFLOW_REF: 'pbjustin/Arcanos/.github/workflows/railway-stacked-draft-preview.yml@refs/heads/codex/preview' },
    { CONTROLLER_SHA: 'f'.repeat(40) }, { WORKFLOW_RUN_ATTEMPT: '2' }, { WORKFLOW_RUN_ID: '`id`' },
    { AUTHORIZATION_JSON: '$(touch escaped)' }, { AUTHORIZATION_JSON: ' '.repeat(16385) },
    { AUTHORIZATION_JSON: JSON.stringify({ ...authorization(), mainSha: '$(touch escaped)' }) },
    { AUTHORIZATION_JSON: JSON.stringify({ ...authorization(), stack: [{ prNumber: 1533, headSha: SHA, treeSha: SHA }] }) },
  ];
  for (const [index, environment] of variants.entries()) {
    const directory = mkdtempSync(path.join(tmpdir(), 'stacked-workflow-dispatch-'));
    try {
      const result = runInline(step, directory, environment);
      assert.equal(result.status, index === 0 ? 0 : 1, result.stderr);
      assert.equal(existsSync(path.join(directory, 'stacked-preview-authorization.json')), index === 0);
      assert.equal(existsSync(path.join(directory, 'escaped')), false);
      if (index === 0) assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'stacked-preview-authorization.json'), 'utf8')), authorization());
      else assert.equal(result.stderr.trim(), 'STACKED_PREVIEW_DISPATCH_INVALID');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const checkoutIndex = workflow.jobs.authorize.steps.findIndex(value => value.uses?.startsWith('actions/checkout@'));
  assert.ok(checkoutIndex > 0);
  assert.equal(named(workflow.jobs.authorize, 'Materialize validated authorization after trusted checkout').run.includes('RUNNER_TEMP'), true);
  for (const job of Object.values(workflow.jobs)) for (const value of job.steps)
    if (value.run) assert.doesNotMatch(value.run, /\$\{\{\s*(?:inputs|github\.event)/u);
});

test('every subsequent job checks default-branch owner trust before immutable checkout', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 25);
    if (name === 'authorize') continue;
    const step = job.steps[0];
    assert.equal(step.name, 'Verify trusted context before checkout');
    for (const environment of [{}, { EVENT_ACTOR: 'contributor' }, { EVENT_SENDER: 'contributor' },
      { EVENT_REPOSITORY: 'fork/Arcanos' }, { EVENT_REF: 'refs/heads/pr' },
      { EVENT_WORKFLOW_REF: 'pbjustin/Arcanos/.github/workflows/railway-stacked-draft-preview.yml@refs/heads/pr' },
      { CONTROLLER_SHA: '${{ secrets.TOKEN }}' }, { WORKFLOW_RUN_ATTEMPT: '2' }]) {
      const directory = mkdtempSync(path.join(tmpdir(), 'stacked-workflow-trust-'));
      try {
        assert.equal(runInline(step, directory, environment).status,
          Object.keys(environment).length === 0 ? 0 : 1, `${name}: ${JSON.stringify(environment)}`);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses) assert.ok(allowedActions.has(step.uses), `Unreviewed action ${step.uses}`);
    if (step.uses?.startsWith('actions/checkout@')) {
      assert.equal(step.with['persist-credentials'], false);
      assert.ok(['${{ github.workflow_sha }}', '${{ needs.authorize.outputs.candidate_sha }}'].includes(step.with.ref));
    }
    if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with['node-version'], '24.18.1');
    if (step.uses?.startsWith('actions/upload-artifact@')) {
      assert.equal(step.with['retention-days'], 10);
      assert.equal(step.with['include-hidden-files'], true);
    }
  }
});

test('candidate build and evidence verification stay separate from Railway and registry credentials', () => {
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /secrets\.|packages:|RAILWAY.*TOKEN|GHCR_TOKEN|npm (?:ci|install)|docker (?:run|exec)/u);
  const build = named(workflow.jobs.build, 'Build immutable secretless candidate image');
  assert.deepEqual(build.env, { GITHUB_TOKEN: '' });
  assert.equal(build.run, 'node scripts/stacked-draft-preview-build.mjs build .stacked-preview/authorization.json .stacked-preview');
  const fetch = named(workflow.jobs.build, 'Fetch only authorized commit objects');
  assert.match(fetch.run, /ownerInput\.stack\.map\(entry => entry\.headSha\)/u);
  assert.match(fetch.run, /\['fetch', '--no-tags', 'origin', sha\]/u);
  assert.doesNotMatch(fetch.run, /pull\/|refs\/heads|git checkout|git switch/u);
  for (const name of ['publish', 'deploy', 'cleanup']) assert.equal(workflow.jobs[name].environment, 'railway-stacked-draft-preview');
  assert.deepEqual(workflow.jobs.publish.permissions, { checks: 'read', contents: 'read', packages: 'write', 'pull-requests': 'read' });
  assert.deepEqual(workflow.jobs.deploy.permissions, { checks: 'read', contents: 'read', 'pull-requests': 'read' });
  assert.deepEqual(workflow.jobs.cleanup.permissions, { contents: 'read' });
  const credentialSteps = Object.entries(workflow.jobs).flatMap(([job, value]) => value.steps.filter(step => JSON.stringify(step.env ?? {}).includes('secrets.')).map(step => ({ job, step })));
  assert.deepEqual(credentialSteps.map(value => value.job), ['deploy', 'cleanup']);
  for (const { step } of credentialSteps) {
    assert.equal(step.env.RAILWAY_API_TOKEN, '${{ secrets.RAILWAY_STACKED_DRAFT_PREVIEW_API_TOKEN }}');
    assert.match(step.run, /^node scripts\/railway-stacked-draft-preview\.mjs (?:deploy|cleanup)/u);
    assert.doesNotMatch(step.run, /npm|candidate|docker|source\.tar/u);
  }
  assert.doesNotMatch(JSON.stringify(workflow.jobs.publish), /secrets\.|npm|docker (?:run|exec)|gh api|method: '(?:PATCH|PUT|POST)'/u);
  const verify = workflow.jobs.verify;
  assert.deepEqual(verify.permissions, { checks: 'read', contents: 'read', 'pull-requests': 'read' });
  assert.doesNotMatch(JSON.stringify(verify), /secrets\.|RAILWAY.*TOKEN|GHCR_TOKEN|npm|Notion|publisher/u);
  const recheck = named(verify, 'Revalidate owner and current exact stack immediately before probe');
  assert.deepEqual(recheck.env, { GITHUB_TOKEN: '${{ github.token }}' });
  assert.equal(recheck['working-directory'], 'trusted');
  assert.match(recheck.run, /railway-stacked-draft-preview\.mjs authorize/u);
  const probe = named(verify, 'Run closed synthetic matrix and passive worker denials');
  assert.deepEqual(probe.env, { GITHUB_TOKEN: '' });
  assert.match(probe.run, /trusted\/scripts\/stacked-draft-preview-probe\.mjs/u);
  assert.match(probe.run, /--git-evidence-root "\$GITHUB_WORKSPACE\/head-evidence"/u);
  assert.match(probe.run, /--execute --allow-network/u);
  assert.ok(verify.steps.indexOf(recheck) < verify.steps.indexOf(probe));
});

test('publisher verifies image before credentials and binds publication to digest and build receipt', () => {
  const publish = workflow.jobs.publish;
  const load = named(publish, 'Verify and load image before registry authentication');
  const push = named(publish, 'Publish static image and record immutable registry digest');
  assert.ok(publish.steps.indexOf(load) < publish.steps.indexOf(push));
  const recheck = named(publish, 'Revalidate owner and current exact stack before publication');
  const visibility = named(publish, 'Require preexisting private container package before publication');
  assert.ok(publish.steps.indexOf(load) < publish.steps.indexOf(recheck));
  assert.ok(publish.steps.indexOf(recheck) < publish.steps.indexOf(visibility));
  assert.ok(publish.steps.indexOf(visibility) < publish.steps.indexOf(push));
  assert.deepEqual(recheck.env, { GITHUB_TOKEN: '${{ github.token }}' });
  assert.match(recheck.run, /railway-stacked-draft-preview\.mjs authorize/u);
  assert.equal(recheck['continue-on-error'], undefined);
  assert.equal(visibility['continue-on-error'], undefined);
  assert.equal(push.if, undefined);
  assert.match(load.run, /stacked-draft-preview-build\.mjs verify .*authorization\.json .*build\.json .*image\.tar/u);
  assert.equal(load.env, undefined);
  assert.deepEqual(push.env, { GHCR_TOKEN: '${{ github.token }}' });
  assert.match(push.run, /\['login', 'ghcr\.io', '--username', 'pbjustin', '--password-stdin'\]/u);
  assert.match(push.run, /\['logout', 'ghcr\.io'\]/u);

  for (const [index, environment] of [{}, { MOCK_DIGEST: 'ghcr.io/other/image@sha256:' + 'c'.repeat(64) },
    { MOCK_IMAGE_ID: `sha256:${'f'.repeat(64)}` }].entries()) {
    const directory = mkdtempSync(path.join(tmpdir(), 'stacked-workflow-publish-'));
    try {
      mkdirSync(path.join(directory, '.stacked-preview'));
      const buildBytes = JSON.stringify({ imageId: IMAGE_ID }) + '\n';
      writeFileSync(path.join(directory, '.stacked-preview/build.json'), buildBytes);
      writeFileSync(path.join(directory, '.stacked-preview/authorization.json'), JSON.stringify({
        ...authorization(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const dockerFile = path.join(directory, 'docker');
      writeFileSync(dockerFile, `#!${process.execPath}\n` +
        "import { appendFileSync } from 'node:fs';\n" +
        "const args = process.argv.slice(2); appendFileSync(process.env.MOCK_COMMAND_LOG, JSON.stringify(args) + '\\n');\n" +
        "if (args[0] === 'image' && args.includes('{{.Id}}')) console.log(process.env.MOCK_IMAGE_ID);\n" +
        "if (args[0] === 'image' && args.includes('{{json .RepoDigests}}')) console.log(JSON.stringify([process.env.MOCK_DIGEST]));\n");
      chmodSync(dockerFile, 0o700);
      const result = runInline(push, directory, { PATH: `${directory}:${process.env.PATH}`,
        GHCR_TOKEN: 'test-only-token-sentinel', MOCK_IMAGE_ID: IMAGE_ID, MOCK_DIGEST: IMAGE,
        MOCK_COMMAND_LOG: path.join(directory, 'commands.jsonl'), ...environment });
      assert.equal(result.status, index === 0 ? 0 : 1, result.stderr);
      assert.equal(existsSync(path.join(directory, '.stacked-preview/published.json')), index === 0);
      const commands = readFileSync(path.join(directory, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(commands[0][0], 'login');
      assert.deepEqual(commands.at(-1), ['logout', 'ghcr.io']);
      assert.ok(commands.every(args => !['run', 'exec', 'build'].includes(args[0])));
      assert.doesNotMatch(result.stdout + result.stderr, /test-only-token-sentinel/u);
      if (index === 0) assert.deepEqual(JSON.parse(readFileSync(path.join(directory, '.stacked-preview/published.json'), 'utf8')),
        { image: IMAGE, imageId: IMAGE_ID, buildReceiptSha256: createHash('sha256').update(buildBytes).digest('hex') });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('public, missing, inaccessible or malformed container packages cannot reach registry authentication', () => {
  const publish = workflow.jobs.publish;
  const step = named(publish, 'Require preexisting private container package before publication');
  assert.deepEqual(step.env, { GITHUB_TOKEN: '${{ github.token }}' });
  assert.doesNotMatch(step.run, /docker|PATCH|POST|PUT|DELETE|packages.*permission/u);
  const metadata = { id: 123, name: 'arcanos-stacked-preview', package_type: 'container', visibility: 'private', owner: { login: 'pbjustin' } };
  const variants = [
    {}, { metadata: { ...metadata, visibility: 'public' } }, { status: 404 }, { status: 403 },
    { metadata: { ...metadata, name: 'other-image' } }, { metadata: { ...metadata, package_type: 'npm' } },
    { metadata: { ...metadata, owner: { login: 'other-owner' } } }, { metadata: { ...metadata, id: 0 } },
    { body: '{malformed' }, { body: ' '.repeat(16385) }, { contentType: 'text/html' },
    { redirected: true }, { unavailable: true },
  ];
  for (const [index, variant] of variants.entries()) {
    const directory = mkdtempSync(path.join(tmpdir(), 'stacked-workflow-private-registry-'));
    try {
      mkdirSync(path.join(directory, '.stacked-preview'));
      const response = { status: variant.status ?? 200, metadata: variant.metadata ?? metadata,
        body: variant.body, contentType: variant.contentType ?? 'application/json', redirected: variant.redirected ?? false,
        unavailable: variant.unavailable ?? false };
      const setup = `const fixture = ${JSON.stringify(response)}; globalThis.fetch = async (url, options) => {
        if (url !== 'https://api.github.com/users/pbjustin/packages/container/arcanos-stacked-preview'
          || options.method !== 'GET' || options.redirect !== 'error'
          || options.headers.authorization !== 'Bearer test-only-token-sentinel') throw new Error('untrusted request');
        if (fixture.unavailable) throw new Error('network unavailable');
        const bytes = new TextEncoder().encode(fixture.body ?? JSON.stringify(fixture.metadata));
        return { status: fixture.status, redirected: fixture.redirected,
          headers: new Headers({ 'content-type': fixture.contentType }),
          body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
      };\n`;
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: directory, input: setup + inline(step), encoding: 'utf8', timeout: 5_000,
        env: { ...baseEnvironment(directory), GITHUB_TOKEN: 'test-only-token-sentinel' },
      });
      assert.equal(result.status, index === 0 ? 0 : 1, result.stderr);
      assert.equal(existsSync(path.join(directory, '.stacked-preview/registry-visibility.json')), index === 0);
      assert.equal(existsSync(path.join(directory, '.stacked-preview/published.json')), false);
      assert.doesNotMatch(result.stdout + result.stderr, /test-only-token-sentinel/u);
      if (index === 0) {
        const receipt = JSON.parse(readFileSync(path.join(directory, '.stacked-preview/registry-visibility.json'), 'utf8'));
        assert.equal(receipt.visibility, 'private'); assert.equal(receipt.packageId, 123);
      } else assert.equal(result.stderr.trim(), 'STACKED_PREVIEW_PRIVATE_REGISTRY_REQUIRED');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('expired authorization cannot authenticate or publish an image', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stacked-workflow-expired-publication-'));
  try {
    mkdirSync(path.join(directory, '.stacked-preview'));
    writeFileSync(path.join(directory, '.stacked-preview/build.json'), JSON.stringify({ imageId: IMAGE_ID }));
    writeFileSync(path.join(directory, '.stacked-preview/authorization.json'), JSON.stringify({
      ...authorization(), expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }));
    const result = runInline(named(workflow.jobs.publish, 'Publish static image and record immutable registry digest'), directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /STACKED_PREVIEW_AUTHORIZATION_EXPIRED/u);
    assert.equal(existsSync(path.join(directory, '.stacked-preview/published.json')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cleanup always follows verification and retains deployment ownership and outcome receipts', () => {
  const cleanup = workflow.jobs.cleanup;
  assert.deepEqual(cleanup.needs, ['authorize', 'publish', 'deploy', 'verify']);
  assert.match(cleanup.if, /always\(\)/u);
  assert.match(cleanup.if, /needs\.deploy\.result != 'skipped'/u);
  assert.doesNotMatch(cleanup.if, /needs\.(?:deploy|verify)\.result == 'success'/u);
  assert.match(named(cleanup, 'Clean owned preview even after authorization expiry').run,
    /--deployment \.stacked-preview\/deployment\.json --output \.stacked-preview\/cleanup\.json/u);
  for (const [jobName, stepName, artifactName] of [
    ['authorize', 'Retain authorization receipt', 'stacked-preview-authorization'],
    ['publish', 'Retain immutable publication receipt', 'stacked-preview-publication'],
    ['deploy', 'Retain deployment and isolation receipt', 'stacked-preview-deployment'],
    ['verify', 'Retain synthetic verification receipt', 'stacked-preview-verification'],
    ['cleanup', 'Retain cleanup receipt', 'stacked-preview-cleanup'],
  ]) {
    const step = named(workflow.jobs[jobName], stepName);
    assert.equal(step.if, 'always()');
    assert.equal(step.with.name, artifactName);
  }
});
