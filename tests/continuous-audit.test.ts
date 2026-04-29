import { spawnSync } from 'node:child_process';

import { describe, expect, it } from '@jest/globals';

const REPO_ROOT = process.cwd();

interface ScriptTargetFinding {
  script: string;
  missingPath: string;
  classification: string;
}

interface OpenAiFinding {
  file: string;
  finding: string;
  blocking: boolean;
  exception?: {
    policy?: string;
  };
}

function runContinuousAudit(): {
  reports: {
    scriptTargets: { findings: ScriptTargetFinding[] };
    openAiCompliance: { findings: OpenAiFinding[] };
  };
} {
  const result = spawnSync(process.execPath, ['scripts/continuous-audit.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, any>;
}

describe('continuous audit report', () => {
  it('classifies the current missing npm script targets', () => {
    const report = runContinuousAudit();
    const findings = report.reports.scriptTargets.findings;
    const classifications = Object.fromEntries(
      findings.map((finding) => [
        `${finding.script}:${finding.missingPath}`,
        finding.classification
      ])
    );

    expect(classifications).toEqual({
      'db:init:scripts/db-init.js': 'rename expectation',
      'db:patch:scripts/schema-sync.js': 'needs human decision',
      'guide:generate:scripts/generate-tagged-guide.js': 'remove stale expectation',
      'sync:auto:scripts/auto-sync-watcher.js': 'rename expectation',
      'test:doc-workflow:scripts/test-doc-workflow.js': 'remove stale expectation'
    });
  });

  it('keeps known raw OpenAI script constructors visible as migration exceptions', () => {
    const report = runContinuousAudit();
    const openAiFindings = report.reports.openAiCompliance.findings;

    expect(openAiFindings.map((finding) => finding.file)).toEqual([
      'scripts/assistants-sync.ts',
      'scripts/compare-finetune-checkpoints.ts',
      'scripts/migration-repair.js'
    ]);
    for (const finding of openAiFindings) {
      expect(finding.finding).toBe('Raw OpenAI SDK constructor outside canonical adapter boundary.');
      expect(finding.exception?.policy).toBe('known_migration_deprecation');
      expect(finding.blocking).toBe(false);
    }
  });
});
