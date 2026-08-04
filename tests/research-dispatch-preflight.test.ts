import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const isRegisteredResearchGptIdMock = jest.fn<() => Promise<boolean>>();

jest.unstable_mockModule('../src/services/researchGptRouting.js', () => ({
  isRegisteredResearchGptId: isRegisteredResearchGptIdMock,
}));

const {
  dispatchResearchGptAdmissionBoundary,
  dispatchResearchGptPreflightBoundary,
} = await import('../src/routes/_core/researchGptPreflight.js');
const {
  dispatchDagCompatibilityBoundary,
} = await import('../src/services/controlPlane/dispatchDagCompatibilityBoundary.js');
const {
  createPublicProviderAdmissionMiddleware,
} = await import('../src/transport/http/middleware/publicProviderAdmission.js');
const {
  getResearchGptPromptPreflight,
  RESEARCH_REQUEST_VALIDATION_ERROR_CODE,
} = await import('../src/shared/researchRequest.js');

function buildApp(options: {
  bodyOverride?: unknown;
  events: string[];
  rateLimitMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}) {
  const app = express();
  app.use(express.json());
  if (Object.prototype.hasOwnProperty.call(options, 'bodyOverride')) {
    app.use((req, _res, next) => {
      req.body = options.bodyOverride;
      next();
    });
  }
  app.post(
    '/dispatch',
    dispatchDagCompatibilityBoundary,
    dispatchResearchGptAdmissionBoundary,
  );
  app.use(createPublicProviderAdmissionMiddleware({
    legacyGptRoutesEnabled: false,
    rateLimitMiddleware: options.rateLimitMiddleware,
  }));
  app.post(
    '/dispatch',
    dispatchResearchGptPreflightBoundary,
    (req, res) => {
      options.events.push('terminal');
      const preflight = getResearchGptPromptPreflight(req);
      if (preflight?.validationError) {
        res.status(400).json({
          ok: false,
          error: {
            code: preflight.validationError.code,
            message: preflight.validationError.message,
          },
        });
        return;
      }
      res.json({ ok: true, promptText: preflight?.promptText ?? null });
    },
  );
  return app;
}

describe('Research /dispatch preflight ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isRegisteredResearchGptIdMock.mockResolvedValue(true);
  });

  it('accounts an invalid Research run before rejecting it without dispatch', async () => {
    const events: string[] = [];
    const rateLimitMiddleware = jest.fn(
      (_req: Request, _res: Response, next: NextFunction) => {
        events.push('admission');
        next();
      },
    );

    const response = await request(buildApp({ events, rateLimitMiddleware }))
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: 'research',
        action: 'run',
        payload: { topic: 't'.repeat(501) },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: RESEARCH_REQUEST_VALIDATION_ERROR_CODE,
      message: 'Research topic must be no more than 500 JavaScript String.length units.',
    });
    expect(events).toEqual(['admission', 'terminal']);
    expect(rateLimitMiddleware).toHaveBeenCalledTimes(1);
  });

  it('does not inspect messages for an explicit /dispatch diagnostic', async () => {
    const events: string[] = [];
    const rateLimitMiddleware = jest.fn(
      (_req: Request, _res: Response, next: NextFunction) => {
        events.push('admission');
        next();
      },
    );
    const messages = new Proxy([{ role: 'user', content: 'ignored' }], {
      get(target, property, receiver) {
        if (property === '0' || property === 'map') {
          throw new Error('diagnostic messages were traversed');
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') {
          throw new Error('diagnostic messages were inspected');
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const body = {
      target: 'gpt',
      gptId: 'research',
      action: 'ping',
      messages,
    };

    const response = await request(buildApp({
      bodyOverride: body,
      events,
      rateLimitMiddleware,
    }))
      .post('/dispatch')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, promptText: null });
    expect(events).toEqual(['terminal']);
    expect(rateLimitMiddleware).not.toHaveBeenCalled();
  });
});
