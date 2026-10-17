import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync('.github/workflows/arcanos-code-analysis.yml', 'utf8'));
const job = workflow.jobs['arcanos-analysis'];
const analysisId = 'arcanos_analysis';
const reports = [
  ['📝 Post PR Comment (if PR)', "always() && github.event_name == 'pull_request' && steps.arcanos_analysis.outcome == 'success'"],
  ['📝 Create Issue for Critical Findings', "always() && steps.arcanos_analysis.outcome == 'success'"]
];

describe('ARCANOS analysis workflow step references', () => {
  it('assigns a unique stable ASCII id to the analysis step before its consumers', () => {
    const analysis = job.steps.find(step => step.name === '🤖 Run ARCANOS Analysis');
    expect(analysis.id).toBe(analysisId);
    expect(analysis.id).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/u);
    expect(job.steps.filter(step => step.id === analysisId)).toEqual([analysis]);
    for (const [name] of reports) {
      const consumerIndex = job.steps.findIndex(step => step.name === name);
      expect(consumerIndex).toBeGreaterThan(job.steps.indexOf(analysis));
    }
  });

  it.each(reports)('%s accepts only success, excluding failure, cancelled and skipped outcomes', (name, condition) => {
    const report = job.steps.find(step => step.name === name);
    // Pin the complete reviewed guard: a valid reference alone must not admit
    // failed, cancelled or skipped analysis, or drop the existing PR event gate.
    expect(report.if).toBe(condition);
  });

  it('retains manual admission and the existing job permissions', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(job.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(job.permissions).toEqual({
      contents: 'write', actions: 'write', issues: 'read', 'pull-requests': 'write'
    });
  });
});
