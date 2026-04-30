import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('custom GPT route OpenAPI contract', () => {
  it('documents no public GPT direct control actions while preserving safe DAG bridge examples', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), 'contracts/custom_gpt_route.openapi.v1.json'), 'utf8')
    );

    const requestExamples =
      contract.paths?.['/gpt/{gptId}']?.post?.requestBody?.content?.['application/json']?.examples;
    const requestExampleActions = Object.values(requestExamples ?? {}).map((example) => {
      const typedExample = example as { value?: { action?: unknown } };
      return typedExample.value?.action;
    });

    expect(requestExampleActions).toEqual(
      expect.arrayContaining([
        'dag.capabilities',
        'dag.dispatch',
        'dag.status',
        'dag.trace'
      ])
    );
    expect(requestExampleActions).not.toContain('diagnostics');
    expect(requestExampleActions).not.toContain('system_state');
    expect(requestExampleActions).not.toContain('get_status');
    expect(requestExampleActions).not.toContain('get_result');
    expect(JSON.stringify(requestExamples)).not.toContain('runtime.inspect');
    expect(JSON.stringify(requestExamples)).not.toContain('workers.status');

    const controlActionsSchema =
      contract.components?.schemas?.GptDispatcherDiagnosticsResponse?.properties?.controlActions;
    expect(controlActionsSchema?.maxItems).toBe(0);
    expect(controlActionsSchema?.items?.enum).toBeUndefined();
  });
});
