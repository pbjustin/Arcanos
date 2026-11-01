import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import yaml from 'js-yaml';

const approval = yaml.load(readFileSync('.github/workflows/require-approval.yml', 'utf8'));
const script = approval.jobs['require-approval'].steps[0].with.script;
const head = 'a'.repeat(40);
const review = (state = 'APPROVED', overrides = {}) => ({
  state, commit_id: head, user: { login: 'reviewer', type: 'User' }, ...overrides
});

async function evaluate(reviews, { labels = ['autonomy-2'], permission = 'write' } = {}) {
  const failed = jest.fn();
  const paginate = jest.fn(async () => reviews);
  const getPermission = jest.fn(async () => ({ data: { permission } }));
  const getPr = jest.fn(async () => ({ data: {
    number: 42, labels: labels.map(name => ({ name })),
    user: { login: 'author' }, head: { sha: head }
  } }));
  await vm.runInNewContext(`(async () => { ${script} })()`, {
    context: { payload: { pull_request: { number: 42 } }, repo: { owner: 'owner', repo: 'repo' } },
    core: { info: jest.fn(), setFailed: failed },
    github: {
      paginate,
      rest: { pulls: { get: getPr, listReviews: jest.fn() },
        repos: { getCollaboratorPermissionLevel: getPermission } }
    }
  });
  return { failed, paginate, getPermission, getPr };
}

describe('label-based independent human approval', () => {
  it.each([
    ['missing approval', []],
    ['author approval', [review('APPROVED', { user: { login: 'author', type: 'User' } })]],
    ['bot approval', [review('APPROVED', { user: { login: 'app[bot]', type: 'Bot' } })]],
    ['stale approval', [review('APPROVED', { commit_id: 'b'.repeat(40) })]],
    ['dismissed approval', [review(), review('DISMISSED')]],
    ['changes requested after approval', [review(), review('CHANGES_REQUESTED')]]
  ])('rejects %s', async (_name, reviews) => {
    expect((await evaluate(reviews)).failed).toHaveBeenCalledTimes(1);
  });

  it('accepts a current independent human approval and preserves it after a comment', async () => {
    expect((await evaluate([review(), review('COMMENTED')])).failed).not.toHaveBeenCalled();
  });

  it.each(['read', 'triage', 'none'])('rejects reviewers with %s permission', async permission => {
    expect((await evaluate([review()], { permission })).failed).toHaveBeenCalledTimes(1);
  });

  it.each(['write', 'maintain', 'admin'])('accepts a human reviewer with %s permission', async permission => {
    expect((await evaluate([review()], { permission })).failed).not.toHaveBeenCalled();
  });

  it('paginates all reviews and fetches current labels/head rather than using event snapshots', async () => {
    const result = await evaluate([...Array(100).fill(review('COMMENTED')), review()]);
    expect(result.failed).not.toHaveBeenCalled();
    expect(result.paginate).toHaveBeenCalledTimes(1);
    expect(result.getPr).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 42 });
  });

  it('leaves unlabeled PRs to independent native branch protection', async () => {
    const result = await evaluate([], { labels: [] });
    expect(result.failed).not.toHaveBeenCalled();
    expect(result.paginate).not.toHaveBeenCalled();
  });

  it('runs only trusted inline policy with read-only permissions and a pinned action', () => {
    expect(approval.permissions).toEqual({ 'pull-requests': 'read' });
    expect(approval.jobs['require-approval'].steps).toHaveLength(1);
    expect(approval.jobs['require-approval'].steps[0].uses).toMatch(/^actions\/github-script@[a-f0-9]{40}$/u);
    expect(approval.concurrency['cancel-in-progress']).toBe(true);
  });
});

describe('deployment reporting and dependency maintenance', () => {
  it('retires the simulated deployment without removing the authoritative Railway path', () => {
    expect(existsSync('.github/workflows/arcanos-deploy.yml')).toBe(false);
    const railway = yaml.load(readFileSync('.github/workflows/railway-auto-deploy.yml', 'utf8'));
    expect(railway.env.ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD).toBe('20260830-job-events-worker-budget-v1');
    expect(railway.jobs['deploy-production'].needs).toBe('rollout-policy');
    expect(railway.jobs['deploy-production'].concurrency).toEqual({
      group: 'railway-auto-deploy-production', 'cancel-in-progress': false
    });
    expect(readFileSync('docs/CI_CD.md', 'utf8')).not.toContain('](../.github/workflows/arcanos-deploy.yml)');
  });

  it('groups weekly updates for the owning npm, Python, and Actions dependency surfaces', () => {
    const dependabot = yaml.load(readFileSync('.github/dependabot.yml', 'utf8'));
    expect(dependabot.version).toBe(2);
    expect(dependabot.updates.map(update => update['package-ecosystem'])).toEqual(['npm', 'pip', 'github-actions']);
    expect(dependabot.updates[0].directory).toBe('/');
    expect(dependabot.updates[1].directory).toBe('/daemon-python');
    for (const update of dependabot.updates) {
      expect(update.schedule.interval).toBe('weekly');
      expect(update['open-pull-requests-limit']).toBe(2);
      expect(Object.values(update.groups)).toEqual([{ patterns: ['*'] }]);
    }
  });
});
