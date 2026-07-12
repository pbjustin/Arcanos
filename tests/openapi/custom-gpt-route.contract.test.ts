import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function collectLocalRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectLocalRefs(entry, refs);
    }
    return refs;
  }

  if (!value || typeof value !== 'object') {
    return refs;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/')) {
      refs.push(entry);
      continue;
    }
    collectLocalRefs(entry, refs);
  }
  return refs;
}

function resolveLocalRef(document: unknown, ref: string): unknown {
  return ref.slice(2).split('/').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    return (current as Record<string, unknown>)[key];
  }, document);
}

describe('custom GPT route OpenAPI contract', () => {
  it('resolves every local schema reference', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), 'contracts/custom_gpt_route.openapi.v1.json'), 'utf8')
    );

    const localRefs = collectLocalRefs(contract);
    expect(localRefs.length).toBeGreaterThan(0);
    for (const ref of localRefs) {
      expect(resolveLocalRef(contract, ref)).toBeDefined();
    }
  });

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
      expect.arrayContaining([
        'mode',
        'game',
        'prompt',
        'url',
        'urls',
        'guideUrl',
        'guideUrls',
        'evidenceOrigin',
        'requestedVersion',
        'evidenceAttempt',
      ])
    );
    expect(gamingPayload?.properties?.url?.format).toBe('uri');
    expect(gamingPayload?.properties?.urls?.items?.format).toBe('uri');
    expect(gamingPayload?.properties?.guideUrl?.format).toBe('uri');
    expect(gamingPayload?.properties?.guideUrls?.items?.format).toBe('uri');
    expect(gamingPayload?.properties?.evidenceOrigin?.enum).toEqual(['frontend_web_search']);
    expect(gamingPayload?.properties?.evidenceAttempt).toEqual(expect.objectContaining({
      type: 'integer',
      enum: [1],
    }));
    const requestedVersionPattern = new RegExp(
      gamingPayload?.properties?.requestedVersion?.pattern ?? '(?!)'
    );
    for (const value of ['1.0', 'v1.0', 'version 1.0.1', 'PATCH 1.0']) {
      expect(requestedVersionPattern.test(value)).toBe(true);
    }
    expect(requestedVersionPattern.test('guide')).toBe(false);
    expect(requestedVersionPattern.test(`1.0\u202e`)).toBe(false);
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
    expect(contract.info?.version).toBe('1.2.0');
    expect(schemas?.GptRouteSuccessResponse?.anyOf).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/schemas/GamingPublicResponse' },
        { $ref: '#/components/schemas/GptDiagnosticResponse' },
        { $ref: '#/components/schemas/GptRouteGenericResponse' },
      ])
    );
    expect(schemas?.GptDiagnosticResponse?.required).toEqual([
      'status',
      'route',
      'message',
      'requestId',
      'traceId',
    ]);
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
        'evidenceRequest',
      ])
    );
    expect(schemas?.GamingResponseData?.properties?.evidenceRequest).toEqual({
      $ref: '#/components/schemas/GamingEvidenceRequest',
    });
    expect(schemas?.GamingEvidenceRequest?.required).toEqual([
      'required',
      'reason',
      'game',
      'maxCandidateUrls',
      'queries',
    ]);
    expect(schemas?.GamingEvidenceRequest?.properties?.queries?.items?.maxLength).toBe(180);
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
