import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

const providerBearingPrJobs = [
  {
    path: '.github/workflows/arcanos-pr-assistant.yml',
    job: 'arcanos-pr-analysis',
    expectedGate: "if: github.event_name == 'workflow_dispatch'",
  },
  {
    path: '.github/workflows/arcanos-code-analysis.yml',
    job: 'arcanos-analysis',
    expectedGate: "if: github.event_name == 'workflow_dispatch'",
  },
  {
    path: '.github/workflows/auto-update-documentation.yml',
    job: 'update-docs',
    expectedGate: "if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
  },
];

function readWorkflow(path) {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

describe('native PR workflow safety', () => {
  it.each(providerBearingPrJobs)('$path keeps $job manual or main-push only', ({ path, job, expectedGate }) => {
    const workflow = readWorkflow(path);
    const jobStart = workflow.indexOf(`  ${job}:\n`);

    expect(jobStart).toBeGreaterThan(-1);
    expect(workflow.slice(jobStart, jobStart + 240)).toContain(`    ${expectedGate}`);
  });

  it('does not remove the ordinary offline PR CI trigger', () => {
    const workflow = readWorkflow('.github/workflows/ci-cd.yml');

    expect(workflow).toContain('  pull_request:');
    expect(workflow).toContain("OPENAI_API_KEY: 'mock-api-key'");
    expect(workflow).toContain("FORCE_MOCK: 'true'");
    expect(workflow).toContain("OPENAI_BASE_URL: 'http://127.0.0.1:9/v1'");
  });

  it('keeps pull-request API endpoint startup isolated from providers', () => {
    const workflow = readWorkflow('.github/workflows/api-endpoint-tests.yml');

    expect(workflow).toContain('export OPENAI_API_KEY=mock-api-key');
    expect(workflow).toContain('export FORCE_MOCK=true');
    expect(workflow).toContain('export OPENAI_BASE_URL=http://127.0.0.1:9/v1');
    expect(workflow).not.toContain('OPENAI_API_KEY:-');
  });
});
