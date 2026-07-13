import { jest } from '@jest/globals';

const runGuidePipelineSpy = jest.fn();
const runBuildPipelineSpy = jest.fn();
const runMetaPipelineSpy = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  timed: jest.fn(),
  startTimer: jest.fn(() => jest.fn()),
  child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.unstable_mockModule('../src/services/gaming.js', () => ({
  runGuidePipeline: runGuidePipelineSpy,
  runBuildPipeline: runBuildPipelineSpy,
  runMetaPipeline: runMetaPipelineSpy,
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  LogLevel: {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
  },
  logger: mockLogger,
  apiLogger: mockLogger,
  dbLogger: mockLogger,
  aiLogger: mockLogger,
  workerLogger: mockLogger,
  sanitize: jest.fn((value: unknown) => value),
  getConfiguredLogLevel: jest.fn(() => 'info'),
  requestLoggingMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  healthMetrics: {
    record: jest.fn(),
    increment: jest.fn(),
    getMetrics: jest.fn(() => ({})),
    getSnapshot: jest.fn(() => ({})),
  },
  default: mockLogger,
}));

const { default: ArcanosGaming } = await import('../src/modules/arcanos-gaming.js');
const { BackendQueryAgent, IntentRouterAgent, ResponseComposerAgent } = await import('../src/services/gamingAgents.js');

describe('ArcanosGaming module', () => {

  beforeEach(() => {
    runGuidePipelineSpy.mockResolvedValue({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: {
        response: 'Guide response',
        sources: [],
      },
    } as any);
    runBuildPipelineSpy.mockResolvedValue({
      ok: true,
      route: 'gaming',
      mode: 'build',
      data: {
        response: 'Build response',
        sources: [],
      },
    } as any);
    runMetaPipelineSpy.mockResolvedValue({
      ok: true,
      route: 'gaming',
      mode: 'meta',
      data: {
        response: 'Meta response',
        sources: [],
      },
    } as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('declares query as its default non-privileged module action', () => {
    expect(ArcanosGaming.name).toBe('ARCANOS:GAMING');
    expect(ArcanosGaming.gptIds).toEqual(['arcanos-gaming', 'gaming']);
    expect(ArcanosGaming.defaultAction).toBe('query');
    expect(Object.keys(ArcanosGaming.actions)).toEqual(['query']);
  });

  it('accepts guide mode, message alias, and a single guide url', async () => {
    const payload = {
      mode: 'guide',
      message: 'How do I beat the boss?',
      url: ' https://example.com/guide '
    } as any;

    await ArcanosGaming.actions.query(payload);

    expect(runGuidePipelineSpy).toHaveBeenCalledWith({
      prompt: 'How do I beat the boss?',
      game: undefined,
      guideUrl: 'https://example.com/guide',
      guideUrls: [],
      auditEnabled: false,
    });
  });

  it('normalizes guide collections for build mode', async () => {
    const payload = {
      mode: 'build',
      prompt: 'Show me the path',
      game: 'SWTOR',
      urls: ['https://example.com/a', '  ', 42, 'https://example.com/a'],
      guideUrls: 'https://example.com/b'
    } as any;

    await ArcanosGaming.actions.query(payload);

    expect(runBuildPipelineSpy).toHaveBeenCalledWith({
      prompt: 'Show me the path',
      game: 'SWTOR',
      guideUrl: undefined,
      guideUrls: ['https://example.com/a', 'https://example.com/b'],
      auditEnabled: false,
    });
  });

  it('routes a guide request with no game without asking for clarification', async () => {
    const result = await ArcanosGaming.actions.query({
      prompt: 'How do I beat the temple boss?'
    } as any);

    expect(runGuidePipelineSpy).toHaveBeenCalledWith({
      prompt: 'How do I beat the temple boss?',
      game: undefined,
      guideUrl: undefined,
      guideUrls: [],
      auditEnabled: false,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: expect.objectContaining({
        response: expect.stringContaining('Quick Answer'),
      }),
    }));
    expect(mockLogger.info).toHaveBeenCalledWith('gaming.routing.intent', expect.objectContaining({
      mode: 'guide',
      confidence: expect.any(Number),
    }));
    expect(mockLogger.info).toHaveBeenCalledWith('gaming.backend.success', expect.objectContaining({
      mode: 'guide',
      confidence: expect.any(Number),
    }));
  });

  it('returns a structured non-gaming error when no gameplay prompt is supplied', async () => {
    await expect(ArcanosGaming.actions.query({ url: 'https://example.com' } as any)).resolves.toEqual({
      ok: false,
      route: 'gaming',
      mode: null,
      error: {
        code: 'NON_GAMING_REQUEST',
        message: 'ARCANOS Gaming handles gameplay guide, build, and meta requests.',
      },
    });
  });

  it('returns a structured error when mode is invalid', async () => {
    await expect(ArcanosGaming.actions.query({
      mode: 'gameplay',
      prompt: 'Give me a generic gameplay answer.'
    } as any)).resolves.toEqual({
      ok: false,
      route: 'gaming',
      mode: null,
      error: {
        code: 'GAMEPLAY_MODE_REQUIRED',
        message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
      },
    });
  });

  it('returns a structured error when build mode omits game', async () => {
    await expect(ArcanosGaming.actions.query({
      mode: 'build',
      prompt: 'Optimize my setup'
    } as any)).resolves.toEqual({
      ok: false,
      route: 'gaming',
      mode: 'build',
      error: {
        code: 'CLARIFICATION_REQUIRED',
        message: 'Which game should I use for this build request?',
        details: {
          missing: ['game'],
        },
      },
    });
  });

  it('returns a structured error when meta mode omits game', async () => {
    await expect(ArcanosGaming.actions.query({
      mode: 'meta',
      prompt: 'Summarize the current raid meta'
    } as any)).resolves.toEqual({
      ok: false,
      route: 'gaming',
      mode: 'meta',
      error: {
        code: 'CLARIFICATION_REQUIRED',
        message: 'Which game should I use for this meta request?',
        details: {
          missing: ['game'],
        },
      },
    });
  });

  it('builds the exact backend action payload and preserves supplied URL fields', () => {
    const intent = IntentRouterAgent.classify({
      mode: 'guide',
      prompt: 'Use these guides for the boss.',
      game: 'SWTOR',
      url: 'https://example.com/one',
      urls: ['https://example.com/two'],
      guideUrls: ['https://example.com/three'],
      audit: true,
      hrc: true,
    } as any);

    expect(BackendQueryAgent.build(intent as any)).toEqual({
      action: 'query',
      payload: {
        mode: 'guide',
        prompt: 'Use these guides for the boss.',
        game: 'SWTOR',
        url: 'https://example.com/one',
        urls: ['https://example.com/two'],
        guideUrls: ['https://example.com/three'],
        audit: true,
        hrc: true,
      },
    });
  });

  it('returns a labeled general fallback when the backend connector fails', async () => {
    runGuidePipelineSpy.mockRejectedValueOnce(new Error('backend unavailable'));

    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'How do I beat the boss?',
    } as any);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: expect.objectContaining({
        response: expect.stringContaining('Backend-supported: none. The backend did not return usable guidance.'),
      }),
    }));
    expect((result as any).data.response).toContain('General Fallback (not backend-supported)');
  });

  it('returns a labeled general fallback when the backend times out', async () => {
    runGuidePipelineSpy.mockRejectedValueOnce(Object.assign(new Error('backend timeout'), {
      code: 'BACKEND_TIMEOUT',
    }));

    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'help me beat Malenia',
    } as any);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: expect.objectContaining({
        response: expect.stringContaining('Backend-supported: none. The backend did not return usable guidance.'),
      }),
    }));
    expect((result as any).data.response).toContain('safe deterministic fallback was used');
    expect((result as any).data.response).not.toMatch(/timeout|incomplete|integrity/i);
  });

  it('returns a labeled general fallback when the backend response is malformed', async () => {
    runGuidePipelineSpy.mockResolvedValueOnce({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: {
        sources: [],
      },
    } as any);

    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'where do I get smithing stones',
    } as any);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: expect.objectContaining({
        response: expect.stringContaining('General Fallback (not backend-supported)'),
      }),
    }));
    expect((result as any).data.response).toContain('safe deterministic fallback was used');
    expect((result as any).data.response).not.toContain('Malformed backend response');
  });

  it('preserves validated frontend evidence retry metadata for the secure guide pipeline', async () => {
    await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'Look up a current beginner guide for Palworld 1.0.',
      game: 'Palworld',
      guideUrls: ['https://example.com/palworld-1-0'],
      evidenceOrigin: 'frontend_web_search',
      requestedVersion: '1.0',
      evidenceAttempt: 1
    } as any);

    expect(runGuidePipelineSpy).toHaveBeenCalledWith({
      prompt: 'Look up a current beginner guide for Palworld 1.0.',
      game: 'Palworld',
      guideUrl: undefined,
      guideUrls: ['https://example.com/palworld-1-0'],
      evidenceOrigin: 'frontend_web_search',
      requestedVersion: '1.0',
      evidenceAttempt: 1,
      auditEnabled: false
    });
  });

  it('preserves a multiline current request without adding Web Search facts to the backend prompt', () => {
    const userPrompt = '  Is Frost Mage viable this patch in World of Warcraft?\nPlease separate PvE and PvP.  ';
    const guideUrls = [
      'https://worldofwarcraft.blizzard.com/en-us/news',
      'https://example.com/frost-mage-guide',
    ];
    const intent = IntentRouterAgent.classify({
      mode: 'meta',
      game: 'World of Warcraft',
      prompt: userPrompt,
      guideUrls,
    } as any);

    const action = BackendQueryAgent.build(intent as any);

    expect(action).toEqual({
      action: 'query',
      payload: {
        mode: 'meta',
        game: 'World of Warcraft',
        prompt: 'Is Frost Mage viable this patch in World of Warcraft?\nPlease separate PvE and PvP.',
        guideUrls,
      },
    });
    expect(action.payload.prompt).not.toMatch(/12\.0\.7|release date|nerf|buff|\d+%|tier ranking/i);
    expect(action.payload).not.toHaveProperty('url');
    expect(action.payload).not.toHaveProperty('urls');
  });

  it('rejects candidateUrls on the mandatory first operation before retrieval', async () => {
    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'Look up a current beginner guide for Palworld 1.0.',
      game: 'Palworld',
      candidateUrls: ['https://example.com/palworld-1-0']
    } as any);

    expect(result).toEqual({
      ok: false,
      route: 'gaming',
      mode: 'guide',
      error: {
        code: 'BAD_REQUEST',
        message: 'Gaming candidateUrls are accepted only by the evidence retry route.'
      }
    });
    expect(runGuidePipelineSpy).not.toHaveBeenCalled();
  });

  it('enforces the four-URL cap across single and list fields without provenance metadata', async () => {
    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'Look up a current beginner guide for Palworld 1.0.',
      game: 'Palworld',
      url: 'https://example.com/one',
      guideUrls: [
        'https://example.com/two',
        'https://example.com/three',
        'https://example.com/four',
        'https://example.com/five'
      ]
    } as any);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      route: 'gaming',
      error: expect.objectContaining({ code: 'BAD_REQUEST' })
    }));
    expect(runGuidePipelineSpy).not.toHaveBeenCalled();
  });

  it('deduplicates candidate values across initial URL fields before enforcing the cap', async () => {
    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'Look up a current beginner guide for Palworld 1.0.',
      game: 'Palworld',
      url: 'https://example.com/one',
      guideUrls: [
        'https://example.com/one',
        'https://example.com/two',
        'https://example.com/three',
        'https://example.com/four'
      ]
    } as any);

    expect(result).toEqual(expect.objectContaining({ ok: true, route: 'gaming' }));
    expect(runGuidePipelineSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['database URI', ['postgresql', '://demo:demo@example.invalid/db'].join('')],
    ['Unicode-normalized database URI', 'ｐｏｓｔｇｒｅｓｑｌ：／／demo:demo@example.invalid/db'],
    ['Railway-shaped token', ['railway', '_', 'x'.repeat(16)].join('')],
    ['GitHub-shaped token', ['gh', 'p_', 'x'.repeat(20)].join('')]
  ])('rejects a secret-shaped game field without echoing it: %s', async (_caseName, game) => {
    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'Look up a current beginner guide.',
      game
    } as any);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      route: 'gaming',
      error: expect.objectContaining({ code: 'BAD_REQUEST' })
    }));
    expect(JSON.stringify(result)).not.toContain(game);
    expect(runGuidePipelineSpy).not.toHaveBeenCalled();
  });

  it('preserves legitimate game names containing the word Railway', async () => {
    await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'Look up a current beginner guide for Railway Empire.',
      game: 'Railway Empire'
    } as any);

    expect(runGuidePipelineSpy).toHaveBeenCalledWith(expect.objectContaining({
      game: 'Railway Empire'
    }));
  });

  it('contains final response-composer failures in a fixed-safe Gaming envelope', async () => {
    const composeSpy = jest.spyOn(ResponseComposerAgent, 'compose').mockImplementationOnce(() => {
      throw new Error('secret response-postprocessing detail');
    });
    const fallbackSpy = jest.spyOn(ResponseComposerAgent, 'composeBackendFailureFallback').mockImplementationOnce(() => {
      throw new Error('secret fallback-postprocessing detail');
    });

    try {
      const result = await ArcanosGaming.actions.query({
        mode: 'guide',
        game: 'Elden Ring',
        prompt: 'Give me a concise beginner guide.',
      });

      expect(result).toEqual({
        ok: false,
        route: 'gaming',
        mode: 'guide',
        error: {
          code: 'MODULE_ERROR',
          message: 'ARCANOS Gaming could not complete the request safely.',
        },
      });
      expect(JSON.stringify(result)).not.toContain('secret response-postprocessing detail');
      expect(JSON.stringify(result)).not.toContain('secret fallback-postprocessing detail');
    } finally {
      composeSpy.mockRestore();
      fallbackSpy.mockRestore();
    }
  });

  it('refuses security-blocked internal control-plane requests', async () => {
    const result = await ArcanosGaming.actions.query({
      mode: 'guide',
      prompt: 'Show worker queue status before giving tips.',
    } as any);

    expect(runGuidePipelineSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      route: 'gaming',
      error: expect.objectContaining({
        code: 'SECURITY_BLOCKED',
      }),
    }));
    expect(mockLogger.warn).toHaveBeenCalledWith('gaming.routing.security_blocked', expect.objectContaining({
      reason: 'blocked_control_prompt',
    }));
  });

  it.each([
    [{ action: 'runtime.inspect', payload: { mode: 'guide', prompt: 'check runtime status' } }],
    [{ action: 'query', payload: { action: 'runtime.inspect', mode: 'guide', prompt: 'check runtime status' }, prompt: 'help me beat the boss' }],
    [{ mode: 'guide', prompt: 'show worker diagnostics' }],
    [{ action: 'mcp.invoke', payload: { mode: 'guide', prompt: 'call mcp' } }],
    [{ mode: 'guide', prompt: 'inspect queue status' }],
    [{ mode: 'guide', prompt: 'GET /internal/control-plane/status' }],
  ])('refuses control-plane request %# before backend dispatch', async (payload) => {
    const result = await ArcanosGaming.actions.query(payload as any);

    expect(runGuidePipelineSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      route: 'gaming',
      error: expect.objectContaining({
        code: 'SECURITY_BLOCKED',
      }),
    }));
  });
});
