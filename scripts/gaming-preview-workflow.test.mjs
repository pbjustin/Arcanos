import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildNativePrPreviewRequestPlan } from './native-pr-preview-e2e.mjs';
import { evaluateCoordinatedRolloutGuard } from './railway-coordinated-rollout-guard.mjs';

const require = createRequire(import.meta.url);
const { load } = require('js-yaml');
const ts = require('typescript');
const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const workflow = load(read('.github/workflows/railway-gaming-preview.yml'));
const checks = load(read('.github/workflows/gaming-preview-infrastructure-checks.yml'));
const frozen = '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262';
const trustedRef = '${{ github.workflow_sha }}';
const list = value => Array.isArray(value) ? value : [value];
const runs = job => job.steps.filter(step => typeof step.run === 'string');
const commandStep = (job, fragment) => job.steps.find(step => step.run?.includes(fragment));
const secretPattern = /\bsecrets\s*\.|\b(?:RAILWAY_API_TOKEN|RAILWAY_TOKEN|GHCR_TOKEN|OPENAI_API_KEY|NOTION_TOKEN|DATABASE_URL|REDIS_URL)\b/u;
const management = ['authorize', 'publish', 'deploy', 'verify', 'attest', 'cleanup'];
const invariant = (condition, code) => assert.ok(condition, code);

function assertWorkflowBoundaries(value) {
  invariant(JSON.stringify(Object.keys(value.on)) === JSON.stringify(['workflow_dispatch']), 'MANUAL_TRIGGER_ONLY');
  invariant(JSON.stringify(Object.keys(value.on.workflow_dispatch.inputs)) === JSON.stringify(['authorization_json']), 'CLOSED_AUTHORIZATION_INPUT');
  invariant(value.on.workflow_dispatch.inputs.authorization_json.required === true, 'OWNER_INPUT_REQUIRED');
  assert.deepEqual(value.permissions, {}, 'DEFAULT_NO_AUTHORITY');
  invariant(value.concurrency['cancel-in-progress'] === false, 'NO_DESTRUCTIVE_RUN_REPLACEMENT');
  assert.deepEqual(value.env, { CONTROLLER_SHA: trustedRef, EVENT_SENDER: '${{ github.event.sender.login }}' }, 'NO_GLOBAL_CREDENTIALS');
  const admission = value.jobs.authorize.if;
  for (const clause of ["github.event_name == 'workflow_dispatch'", "github.repository == 'pbjustin/Arcanos'",
    "github.actor == 'pbjustin'", "github.event.sender.login == 'pbjustin'", "github.ref == 'refs/heads/main'",
    "github.workflow_ref == 'pbjustin/Arcanos/.github/workflows/railway-gaming-preview.yml@refs/heads/main'",
    'github.run_attempt == 1']) invariant(admission.includes(clause), 'EXACT_OWNER_PROTECTED_MAIN_ADMISSION');
  invariant(!admission.includes('||'), 'NO_ADMISSION_ALTERNATIVE');
  for (const [name, dependencies] of Object.entries({ build: ['authorize'], publish: ['authorize', 'build'],
    deploy: ['authorize', 'publish'], verify: ['authorize', 'deploy'], attest: ['authorize', 'deploy', 'verify'] })) {
    assert.deepEqual(list(value.jobs[name].needs), dependencies, 'SUCCESS_DEPENDENCY_CHAIN');
    invariant(value.jobs[name].if === undefined, 'NO_FAILED_ADMISSION_BYPASS');
  }

  for (const [name, job] of Object.entries(value.jobs)) {
    invariant(Number.isSafeInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0
      && job['timeout-minutes'] <= 30, 'BOUNDED_HOSTED_JOBS');
    invariant(!job.env && !job.defaults && !job.container && !job.services, 'NO_AMBIENT_EXECUTION_OVERRIDE');
    invariant(['deploy', 'attest', 'cleanup'].includes(name)
      ? job.environment === 'railway-gaming-preview' : !job.environment, 'ISOLATED_ENVIRONMENT_ONLY');
    for (const step of job.steps) {
      if (step.uses) invariant(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@[0-9a-f]{40}$/u.test(step.uses), 'IMMUTABLE_ACTIONS_ONLY');
      invariant(!step['working-directory'] && !step['continue-on-error'], 'NO_EXECUTION_OR_FAILURE_OVERRIDE');
      if (step.uses?.startsWith('actions/checkout@')) {
        invariant(step.with?.['persist-credentials'] === false, 'NO_GIT_CREDENTIAL_PERSISTENCE');
        invariant(step.with?.ref === trustedRef || name === 'verify' && step.with?.ref === frozen
          && step.with?.path === 'head-evidence', 'TRUSTED_CONTROLLER_CHECKOUT');
      }
      if (step.run) invariant(!/\$\{\{[^}]*\b(?:inputs|github\.event\.pull_request)\b/u.test(step.run), 'NO_UNTRUSTED_SHELL_INTERPOLATION');
      for (const [key, content] of Object.entries(step.env ?? {})) if (secretPattern.test(key) || /\bsecrets\s*\./u.test(String(content))) {
        invariant(key === 'GHCR_TOKEN' && name === 'publish' && content === '${{ github.token }}'
          || key === 'RAILWAY_API_TOKEN' && ['deploy', 'attest', 'cleanup'].includes(name)
          && content === '${{ secrets.RAILWAY_GAMING_PREVIEW_API_TOKEN }}', 'EXACT_SCOPED_SECRET_ONLY');
      }
    }
    if (management.includes(name)) {
      invariant(job.steps[0]?.uses?.startsWith('actions/checkout@') && job.steps[0].with?.ref === trustedRef, 'TRUSTED_CODE_BEFORE_MANAGEMENT');
      // Candidate data may be read by fixed trusted programs, but execution in a
      // management process must not move into candidate package or Docker code.
      for (const step of runs(job)) invariant(!/(?:^|[\s;&|])(?:npm|npx|pnpm|yarn|python|docker)\s/u.test(step.run)
        && !/\b(?:cd|node)\s+[^\n]*head-evidence/u.test(step.run.replace(/--git-evidence-root[^\n]*/gu, '')), 'NO_CANDIDATE_EXECUTION_WITH_AUTHORITY');
    }
  }

  for (const [name, job] of Object.entries(value.jobs)) {
    const writes = Object.entries(job.permissions ?? {}).filter(([, permission]) => permission === 'write').map(([scope]) => scope).sort();
    assert.deepEqual(writes, name === 'publish' ? ['attestations', 'id-token', 'packages'] : [], 'SEPARATE_PUBLICATION_AUTHORITY');
  }
  const build = value.jobs.build;
  invariant(!build.environment && !secretPattern.test(JSON.stringify(build)), 'SECRETLESS_BUILD_JOB');
  invariant(commandStep(build, 'scripts/gaming-preview-build.mjs build')?.env?.GITHUB_TOKEN === '', 'NO_BUILD_GITHUB_CREDENTIAL');
  invariant(!runs(build).some(step => /\b(?:publish|deploy|railway up)\b/u.test(step.run)), 'NO_BUILD_PUBLICATION_OR_DEPLOYMENT');
  const publish = value.jobs.publish;
  invariant(!publish.environment && !/\bRAILWAY_API_TOKEN\b|\bsecrets\s*\./u.test(JSON.stringify(publish)), 'NO_PUBLICATION_DEPLOYMENT_CREDENTIAL');
  invariant(commandStep(publish, 'scripts/gaming-preview-publish.mjs')?.env?.GHCR_TOKEN === '${{ github.token }}', 'STATIC_PUBLICATION_ONLY');
  for (const step of publish.steps) for (const [key, content] of Object.entries(step.env ?? {})) {
    if (/token|(?:^|_)pat(?:_|$)/iu.test(key)) invariant(['GITHUB_TOKEN', 'GHCR_TOKEN'].includes(key)
      && content === '${{ github.token }}', 'REPOSITORY_INSTALLATION_TOKEN_ONLY');
  }
  invariant(publish.steps.some(step => step.uses?.startsWith('actions/attest-build-provenance@')
    && ['source.tar', 'image.tar', 'build.json', 'published.json'].every(file => step.with?.['subject-path']?.includes(file))), 'IMMUTABLE_SOURCE_IMAGE_ATTESTATION');

  const verify = value.jobs.verify, verification = commandStep(verify, 'scripts/railway-gaming-preview.mjs verify');
  invariant(!verify.environment && !secretPattern.test(JSON.stringify(verify)), 'NO_VERIFIER_MANAGEMENT_OR_PROVIDER_CREDENTIAL');
  invariant(verification?.env?.GITHUB_TOKEN === '' && verification.env.DEPLOYMENT_RECEIPT_SHA256 === '${{ needs.deploy.outputs.receipt_sha256 }}', 'INDEPENDENT_DEPLOYMENT_RECEIPT_DIGEST');
  invariant(value.jobs.deploy.outputs?.receipt_sha256 === '${{ steps.receipt.outputs.sha256 }}', 'TRUSTED_DEPLOY_JOB_OUTPUT');
  const digest = value.jobs.deploy.steps.find(step => step.id === 'receipt');
  invariant(digest?.run?.includes("createHash('sha256').update(readFileSync('.gaming-preview/deployment.json'))")
    && digest.run.includes('GITHUB_OUTPUT'), 'HASH_ACTUAL_DEPLOYMENT_RECEIPT');
  for (const name of ['publish', 'deploy', 'verify', 'attest']) {
    const steps = value.jobs[name].steps;
    const fetchIndex = steps.findIndex(step => step.run?.includes(`git fetch --no-tags origin ${frozen}`));
    const firstAdmission = steps.findIndex(step => step.run?.includes('scripts/railway-gaming-preview.mjs authorize')
      || step.run?.includes(`scripts/railway-gaming-preview.mjs ${name}`));
    invariant(fetchIndex >= 0 && fetchIndex < firstAdmission, 'FROZEN_OBJECTS_BEFORE_FRESH_ADMISSION');
  }
  const attest = value.jobs.attest;
  invariant(list(attest.needs).includes('verify') && commandStep(attest, 'scripts/railway-gaming-preview.mjs attest'), 'POST_VERIFICATION_CONTROL_PLANE_AUDIT');
  const cleanup = value.jobs.cleanup;
  invariant(cleanup.if?.startsWith('always()') && !/needs\.(?:verify|attest)\.result\s*==\s*'success'/u.test(cleanup.if)
    && ['deploy', 'verify', 'attest'].every(name => list(cleanup.needs).includes(name)), 'ALWAYS_CLEAN_AFTER_EFFECTS');
  invariant(cleanup['timeout-minutes'] <= 7 && commandStep(cleanup, 'scripts/railway-gaming-preview.mjs cleanup'), 'BOUNDED_CONTROL_PLANE_CLEANUP');
  const verdict = value.jobs.verdict;
  invariant(verdict.if === 'always()' && ['verify', 'attest', 'cleanup'].every(name => list(verdict.needs).includes(name)), 'FAIL_CLOSED_FINAL_VERDICT');
  const final = commandStep(verdict, 'GAMING_SCOPED_PREVIEW');
  for (const [key, name] of [['VERIFIED', 'verify'], ['ATTESTED', 'attest'], ['CLEANED', 'cleanup']])
    invariant(final?.env?.[key] === '${{ needs.' + name + '.result }}', 'ALL_REQUIRED_RESULTS_BOUND');
}

test('Gaming workflow enforces protected manual admission and separated privilege boundaries', () => {
  assertWorkflowBoundaries(workflow);
});

function assertPublisherPackageBoundary(source) {
  const parsed = ts.createSourceFile('publisher.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  invariant(parsed.parseDiagnostics.length === 0, 'PUBLISHER_SOURCE_VALID');
  const functions = parsed.statements.filter(ts.isFunctionDeclaration);
  const reader = functions.find(item => item.name?.text === 'readPrivatePackage');
  const publisher = functions.find(item => item.name?.text === 'publishGamingImage');
  invariant(reader?.body && publisher?.body, 'FIXED_PACKAGE_BOUNDARY_REQUIRED');
  const descendants = node => {
    const result = []; const visit = child => { result.push(child); ts.forEachChild(child, visit); };
    visit(node); return result;
  };
  const calls = node => descendants(node).filter(ts.isCallExpression);
  const namedCall = (node, name) => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === name;
  const metadataReads = calls(reader).filter(item => namedCall(item, 'fetchImpl'));
  invariant(metadataReads.length === 1 && ts.isStringLiteral(metadataReads[0].arguments[0])
    && metadataReads[0].arguments[0].text === 'https://api.github.com/user/packages/container/arcanos-gaming-preview',
  'AUTHENTICATED_OWNER_METADATA_ONLY');
  const variables = publisher.body.statements.filter(ts.isVariableStatement)
    .flatMap(item => [...item.declarationList.declarations]);
  const token = variables.find(item => item.name.getText(parsed) === 'token');
  invariant(token?.initializer?.getText(parsed) === 'environment.GHCR_TOKEN', 'NO_METADATA_PAT_FALLBACK');
  const pkg = variables.find(item => item.name.getText(parsed) === 'pkg');
  invariant(pkg?.initializer && ts.isAwaitExpression(pkg.initializer)
    && namedCall(pkg.initializer.expression, 'readPrivatePackage'), 'AWAIT_PACKAGE_ADMISSION');
  const gate = publisher.body.statements.filter(ts.isExpressionStatement).map(item => item.expression)
    .find(item => namedCall(item, 'requireCondition')
      && item.arguments[0]?.getText(parsed).startsWith('pkg.name'));
  invariant(gate, 'DIRECT_PRIVATE_PACKAGE_GATE');
  const conjuncts = node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? [...conjuncts(node.left), ...conjuncts(node.right)] : [node];
  const comparisons = conjuncts(gate.arguments[0]).filter(item => ts.isBinaryExpression(item)
    && item.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isStringLiteral(item.right))
    .map(item => [item.left.getText(parsed), item.right.text]);
  for (const [field, expected] of [['pkg.name', 'arcanos-gaming-preview'], ['pkg.package_type', 'container'],
    ['pkg.visibility', 'private'], ['pkg.owner?.login', 'pbjustin']]) invariant(comparisons.some(([name, value]) =>
      name === field && value === expected), 'EXACT_PRIVATE_OWNER_PACKAGE_REQUIRED');
  const effects = calls(publisher).filter(item => namedCall(item, 'command')
    && ts.isArrayLiteralExpression(item.arguments[0]) && ts.isStringLiteral(item.arguments[0].elements[0])
    && ['load', 'login', 'push'].includes(item.arguments[0].elements[0].text));
  invariant(effects.length === 3 && effects.every(item => pkg.pos < gate.pos && gate.pos < item.pos), 'PRIVATE_ADMISSION_BEFORE_PUBLICATION_EFFECTS');
}

test('publication uses only repository installation tokens and authenticated exact private-owner admission before effects', () => {
  assertWorkflowBoundaries(workflow);
  const source = read('scripts/gaming-preview-publish.mjs');
  assertPublisherPackageBoundary(source);
  const gate = /requireCondition\(pkg\.name[\s\S]*?'PRIVATE_PACKAGE_REQUIRED'\);/u.exec(source)?.[0];
  assert.ok(gate);
  for (const [code, changed] of [
    ['AUTHENTICATED_OWNER_METADATA_ONLY', source.replace('/user/packages/container/', '/users/pbjustin/packages/container/')],
    ['NO_METADATA_PAT_FALLBACK', source.replace('const token = environment.GHCR_TOKEN;', 'const token = environment.GHCR_TOKEN || environment.METADATA_PAT;')],
    ['EXACT_PRIVATE_OWNER_PACKAGE_REQUIRED', source.replace("pkg.visibility === 'private'", "pkg.visibility === 'public'")],
    ['EXACT_PRIVATE_OWNER_PACKAGE_REQUIRED', source.replace("pkg.owner?.login === 'pbjustin'", "pkg.owner?.login === 'other'")],
    ['EXACT_PRIVATE_OWNER_PACKAGE_REQUIRED', source.replace("&& pkg.owner?.login", "|| pkg.owner?.login")],
    ['PRIVATE_ADMISSION_BEFORE_PUBLICATION_EFFECTS', source.replace(gate, '')
      .replace("command(['load', '--input', imageFile]);", "command(['load', '--input', imageFile]);\n" + gate)],
  ]) assert.throws(() => assertPublisherPackageBoundary(changed), error => error.message.includes(code));
});

test('infrastructure merge cannot pass the existing automatic production rollout hold', () => {
  const production = load(read('.github/workflows/railway-auto-deploy.yml'));
  const holdId = production.env.ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD;
  assert.equal(holdId, '20260830-job-events-worker-budget-v1');
  const decision = evaluateCoordinatedRolloutGuard({ eventName: 'workflow_run', holdId });
  assert.equal(decision.shouldDeploy, false);
  assert.equal(decision.reason, 'automatic_promotion_blocked');
  assert.ok(production.jobs['deploy-production'].if.includes("needs.rollout-policy.outputs.should_deploy == 'true'"));
  assert.throws(() => evaluateCoordinatedRolloutGuard({ eventName: 'workflow_dispatch', holdId }), /CONFIRMATION_REQUIRED/u);
});

test('workflow policy rejects trigger, checkout, privilege, receipt, execution and cleanup regressions', () => {
  for (const [code, mutate] of [
    ['MANUAL_TRIGGER_ONLY', value => { value.on.pull_request_target = {}; }],
    ['EXACT_OWNER_PROTECTED_MAIN_ADMISSION', value => { value.jobs.authorize.if = value.jobs.authorize.if.replace("github.actor == 'pbjustin'", 'true'); }],
    ['NO_ADMISSION_ALTERNATIVE', value => { value.jobs.authorize.if += ' || true'; }],
    ['SUCCESS_DEPENDENCY_CHAIN', value => { value.jobs.deploy.needs = []; }],
    ['NO_FAILED_ADMISSION_BYPASS', value => { value.jobs.publish.if = 'always()'; }],
    ['TRUSTED_CONTROLLER_CHECKOUT', value => { value.jobs.deploy.steps[0].with.ref = frozen; }],
    ['NO_GIT_CREDENTIAL_PERSISTENCE', value => { value.jobs.deploy.steps[0].with['persist-credentials'] = true; }],
    ['NO_AMBIENT_EXECUTION_OVERRIDE', value => { value.jobs.build.env = { OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}' }; }],
    ['SEPARATE_PUBLICATION_AUTHORITY', value => { value.jobs.build.permissions.packages = 'write'; }],
    ['NO_CANDIDATE_EXECUTION_WITH_AUTHORITY', value => { value.jobs.publish.steps.push({ run: 'docker run candidate:latest' }); }],
    ['NO_CANDIDATE_EXECUTION_WITH_AUTHORITY', value => { value.jobs.deploy.steps.push({ run: 'npm --prefix head-evidence start' }); }],
    ['ISOLATED_ENVIRONMENT_ONLY', value => { value.jobs.verify.environment = 'railway-gaming-preview'; }],
    ['ISOLATED_ENVIRONMENT_ONLY', value => { value.jobs.deploy.environment = 'production'; }],
    ['EXACT_SCOPED_SECRET_ONLY', value => { commandStep(value.jobs.deploy, 'scripts/railway-gaming-preview.mjs deploy').env.RAILWAY_API_TOKEN = '${{ secrets.RAILWAY_PRODUCTION_API_TOKEN }}'; }],
    ['EXACT_SCOPED_SECRET_ONLY', value => { commandStep(value.jobs.publish, 'scripts/gaming-preview-publish.mjs').env.GHCR_TOKEN = '${{ secrets.PACKAGES_PAT }}'; }],
    ['EXACT_SCOPED_SECRET_ONLY', value => { commandStep(value.jobs.publish, 'scripts/gaming-preview-publish.mjs').env.METADATA_PAT = '${{ secrets.PACKAGES_METADATA_PAT }}'; }],
    ['REPOSITORY_INSTALLATION_TOKEN_ONLY', value => { commandStep(value.jobs.publish, 'scripts/gaming-preview-publish.mjs').env.METADATA_PAT = 'test-only-unused-token'; }],
    ['INDEPENDENT_DEPLOYMENT_RECEIPT_DIGEST', value => { commandStep(value.jobs.verify, 'scripts/railway-gaming-preview.mjs verify').env.GITHUB_TOKEN = '${{ github.token }}'; }],
    ['INDEPENDENT_DEPLOYMENT_RECEIPT_DIGEST', value => { commandStep(value.jobs.verify, 'scripts/railway-gaming-preview.mjs verify').env.DEPLOYMENT_RECEIPT_SHA256 = '${{ inputs.digest }}'; }],
    ['NO_UNTRUSTED_SHELL_INTERPOLATION', value => { value.jobs.authorize.steps.find(step => step.env?.AUTHORIZATION_JSON).run += '\necho "${{ inputs.authorization_json }}"'; }],
    ['ALWAYS_CLEAN_AFTER_EFFECTS', value => { value.jobs.cleanup.if = "needs.verify.result == 'success'"; }],
    ['BOUNDED_HOSTED_JOBS', value => { value.jobs.cleanup['timeout-minutes'] = 90; }],
    ['ALWAYS_CLEAN_AFTER_EFFECTS', value => { value.jobs.cleanup.needs = ['deploy', 'verify']; }],
    ['ALL_REQUIRED_RESULTS_BOUND', value => { commandStep(value.jobs.verdict, 'GAMING_SCOPED_PREVIEW').env.ATTESTED = 'success'; }],
  ]) {
    const changed = structuredClone(workflow); mutate(changed);
    assert.throws(() => assertWorkflowBoundaries(changed), error => error.message.includes(code));
  }
});

function nodeBody(step) {
  const match = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/u.exec(step.run);
  assert.ok(match, 'Reviewed inline Node program required'); return match[1];
}
function temporaryRun(callback) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gaming-workflow-'));
  try { return callback(directory); }
  finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('owner JSON is data, rejects oversized input and cannot become shell execution', () => {
  const step = workflow.jobs.authorize.steps.find(item => item.env?.AUTHORIZATION_JSON);
  const script = nodeBody(step);
  temporaryRun(directory => {
    const payload = { value: '$(touch unauthorized); `touch unauthorized`; ${process.env.GITHUB_TOKEN}',
      controllerSha: frozen };
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, cwd: directory,
      env: { AUTHORIZATION_JSON: JSON.stringify(payload) }, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, '.gaming-preview/authorization.json'))), payload);
    assert.equal(existsSync(path.join(directory, 'unauthorized')), false);
  });
  for (const payload of ['{', JSON.stringify({ value: 'x'.repeat(16384) })]) temporaryRun(directory => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, cwd: directory,
      env: { AUTHORIZATION_JSON: payload }, encoding: 'utf8', timeout: 3000 });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(path.join(directory, '.gaming-preview/authorization.json')), false);
  });
});

test('final verdict cannot report PASS with failed or skipped admission, verification, attestation or cleanup', () => {
  const script = nodeBody(commandStep(workflow.jobs.verdict, 'GAMING_SCOPED_PREVIEW'));
  const keys = ['AUTHORIZED', 'VERIFIED', 'ATTESTED', 'CLEANED'];
  for (const values of [['success', 'success', 'success', 'success'], ...keys.flatMap((_key, index) =>
    ['failure', 'skipped'].map(value => keys.map((_, position) => position === index ? value : 'success')))]) {
    temporaryRun(directory => {
      const summary = path.join(directory, 'summary.txt');
      const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, cwd: directory,
        env: { ...Object.fromEntries(keys.map((key, index) => [key, values[index]])), GITHUB_STEP_SUMMARY: summary },
        encoding: 'utf8', timeout: 3000 });
      const passed = values.every(value => value === 'success');
      assert.equal(result.status, passed ? 0 : 1, result.stderr);
      assert.match(readFileSync(summary, 'utf8'), new RegExp(`GAMING_SCOPED_PREVIEW = ${passed ? 'PASS' : values[0] !== 'success' ? 'NOT_RUN' : 'FAIL'}\\n`, 'u'));
    });
  }
});

test('infrastructure PR checks carry no deployment, package publication or provider authority', () => {
  assert.deepEqual(checks.permissions, { contents: 'read' });
  invariant(!checks.on.pull_request_target && !checks.env, 'NO_PRIVILEGED_PR_TRIGGER');
  for (const job of Object.values(checks.jobs)) {
    invariant(!job.environment && !job.env && !job.permissions && !secretPattern.test(JSON.stringify(job)), 'NO_PR_TEST_SECRETS');
    for (const step of job.steps) if (step.uses) invariant(/@[0-9a-f]{40}$/u.test(step.uses), 'PINNED_PR_CHECK_ACTION');
    invariant(!runs(job).some(step => /scripts\/(?:gaming-preview-publish|railway-gaming-preview)\.mjs\s+(?:deploy|publish|verify)/u.test(step.run)), 'NO_HOSTED_PR_CHECK_EFFECTS');
  }
  invariant(commandStep(checks.jobs.contracts, 'scripts/gaming-preview-*.test.mjs'), 'WORKFLOW_POLICY_TEST_INCLUDED');
});

test('dedicated Gaming admission preserves the complete platform inventory and excludes broad readiness activation', () => {
  const pr = load(read('.github/workflows/pr-ci.yml'));
  invariant(pr.jobs['native-pr-preview-head-e2e'].if.includes('github.event.pull_request.number != 1558'), 'NO_BROAD_GAMING_VERIFIER');
  const lifecycle = read('scripts/railway-pr-preview-lifecycle.mjs');
  invariant(lifecycle.includes('pullRequest.number !== 1558') && lifecycle.includes('current.number !== 1558'), 'NO_BROAD_GAMING_RECONCILIATION');
  const plan = buildNativePrPreviewRequestPlan();
  assert.equal(plan.length, 173);
  assert.equal(createHash('sha256').update(JSON.stringify(plan)).digest('hex'), 'e9c3a2c7953541598877f282ca0ff378ff4cb360db7ba5f382b00902caea22ed');
  assert.ok(plan.some(item => item.fixtureName === 'notionAuthorityRag'));
});
