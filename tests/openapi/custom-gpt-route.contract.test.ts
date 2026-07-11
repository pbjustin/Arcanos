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
    expect(JSON.stringify(contract)).not.toContain('root.deep_diagnostics');
    expect(JSON.stringify(contract)).not.toContain('ROOT_DIAGNOSTICS_FORBIDDEN');

    const controlActionsSchema =
      contract.components?.schemas?.GptDispatcherDiagnosticsResponse?.properties?.controlActions;
    expect(controlActionsSchema?.maxItems).toBe(0);
    expect(controlActionsSchema?.items?.enum).toBeUndefined();
  });

  it('documents ARCANOS Gaming as a module-owned query payload contract', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), 'contracts/custom_gpt_route.openapi.v1.json'), 'utf8')
    );

    const requestExamples =
      contract.paths?.['/gpt/{gptId}']?.post?.requestBody?.content?.['application/json']?.examples;
    expect(requestExamples?.gamingGuideQuery?.value).toEqual({
      action: 'query',
      payload: {
        mode: 'guide',
        prompt: 'Give me beginner tips for surviving the first night.',
        game: 'Minecraft',
      },
    });

    const payloadDescription =
      contract.components?.schemas?.GptRouteRequest?.properties?.payload?.description;
    expect(payloadDescription).toContain('ARCANOS Gaming');
    expect(payloadDescription).toContain('guide, build, or meta');

    const requestSchema =
      contract.paths?.['/gpt/{gptId}']?.post?.requestBody?.content?.['application/json']?.schema;
    expect(requestSchema?.anyOf).toEqual([
      { $ref: '#/components/schemas/GamingQueryRequest' },
      { $ref: '#/components/schemas/GptRouteRequest' },
    ]);

    const gamingPayload = contract.components?.schemas?.GamingQueryPayload;
    expect(gamingPayload?.required).toEqual(['mode', 'prompt']);
    expect(gamingPayload?.properties?.mode?.enum).toEqual(['guide', 'build', 'meta']);
    expect(Object.keys(gamingPayload?.properties ?? {})).toEqual(
      expect.arrayContaining(['mode', 'game', 'prompt', 'url', 'urls', 'guideUrl', 'guideUrls'])
    );
    expect(gamingPayload?.properties?.url?.format).toBe('uri');
    expect(gamingPayload?.properties?.urls?.items?.format).toBe('uri');
    expect(gamingPayload?.properties?.guideUrl?.format).toBe('uri');
    expect(gamingPayload?.properties?.guideUrls?.items?.format).toBe('uri');
  });

  it('binds the canonical production target and documents the public Gaming response envelope', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), 'contracts/custom_gpt_route.openapi.v1.json'), 'utf8')
    );

    expect(contract.servers).toEqual([
      {
        url: 'https://acranos-production.up.railway.app',
        description: 'Canonical ARCANOS production deployment',
      },
    ]);
    expect(contract.security).toBeUndefined();
    expect(contract.paths?.['/gpt/{gptId}']?.post?.security).toBeUndefined();
    expect(JSON.stringify(contract.servers)).not.toContain('arcanos-v2-production');

    const schemas = contract.components?.schemas;
    expect(contract.info?.version).toBe('1.1.0');
    expect(schemas?.GptRouteSuccessResponse?.anyOf).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/schemas/GamingPublicResponse' },
        { $ref: '#/components/schemas/GptRouteGenericResponse' },
      ])
    );
    expect(schemas?.GamingPublicResponse?.required).toEqual([
      'ok',
      'requestId',
      'traceId',
      'result',
      '_route',
    ]);
    expect(schemas?.GamingResult?.oneOf).toEqual([
      { $ref: '#/components/schemas/GamingSuccessResult' },
      { $ref: '#/components/schemas/GamingErrorResult' },
    ]);
    expect(schemas?.GamingResponseData?.required).toEqual(['response', 'sources']);
    expect(schemas?.GamingResponseData?.properties?.sources?.items).toEqual({
      $ref: '#/components/schemas/GamingSource',
    });
    expect(Object.keys(schemas?.GamingResponseData?.properties ?? {})).toEqual(
      expect.arrayContaining([
        'response',
        'sources',
        'fallbackReason',
        'discoveryReason',
        'discoveryFailureReason',
      ])
    );
    expect(schemas?.GamingResponseData?.properties?.fallbackReason?.enum).toContain(
      'CURRENT_EVIDENCE_UNAVAILABLE'
    );
    expect(schemas?.GamingResponseData?.properties?.discoveryFailureReason?.enum).toContain(
      'DISCOVERY_PROVIDER_UNCONFIGURED'
    );
    expect(schemas?.GamingSource?.required).toEqual(['url']);
    expect(Object.keys(schemas?.GamingSource?.properties ?? {})).toEqual(
      expect.arrayContaining(['url', 'snippet', 'error'])
    );
    expect(schemas?.GamingRouteMeta?.allOf?.[1]?.required).toEqual(['requestId', 'traceId']);
    expect(schemas?.GptRouteErrorResponse?.properties?.requestId).toEqual({
      type: 'string',
      minLength: 1,
    });
    expect(schemas?.GptRouteErrorResponse?.properties?.traceId).toEqual({
      type: 'string',
      minLength: 1,
    });
    expect(schemas?.GptRouteErrorResponse?.required).toEqual([
      'ok',
      'requestId',
      'traceId',
      'error',
    ]);

    const errorResponses = contract.paths?.['/gpt/{gptId}']?.post?.responses;
    const errorExamples = [
      ...Object.values(errorResponses?.['400']?.content?.['application/json']?.examples ?? {}),
      ...Object.values(errorResponses?.['503']?.content?.['application/json']?.examples ?? {}),
    ] as Array<{ value?: Record<string, unknown> }>;
    expect(errorExamples).toHaveLength(8);
    for (const example of errorExamples) {
      expect(example.value).toEqual(expect.objectContaining({
        ok: false,
        requestId: 'req_example',
        traceId: 'trace_example',
      }));
    }

    const responses = contract.paths?.['/gpt/{gptId}']?.post?.responses;
    expect(responses?.['400']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/GptRouteErrorResponse',
    });
    for (const status of ['500', '504']) {
      expect(responses?.[status]?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/GptRouteErrorResponse',
      });
    }
  });
});
