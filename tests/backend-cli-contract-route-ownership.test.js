import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';

const JOB_ROUTE_OWNER = 'src/routes/genericJobsRouter.ts';

describe('backend/CLI contract route ownership', () => {
  it('points generic job reads at the reusable router while production keeps the real adapter', async () => {
    const manifest = JSON.parse(
      await fs.readFile(
        new URL('../contracts/backend_cli_contract.v1.json', import.meta.url),
        'utf8',
      ),
    );
    const routeSource = await fs.readFile(
      new URL('../src/routes/genericJobsRouter.ts', import.meta.url),
      'utf8',
    );
    const productionAdapterSource = await fs.readFile(
      new URL('../src/routes/jobs.ts', import.meta.url),
      'utf8',
    );

    expect(manifest.endpoints['/jobs/{id}'].tsRouteFile).toBe(JOB_ROUTE_OWNER);
    expect(manifest.endpoints['/jobs/{id}/result'].tsRouteFile).toBe(JOB_ROUTE_OWNER);
    expect(routeSource).toContain("'/jobs/:id'");
    expect(routeSource).toContain("'/jobs/:id/result'");
    expect(productionAdapterSource).toContain(
      "import { createGenericJobsRouter } from './genericJobsRouter.js';",
    );
    expect(productionAdapterSource).toContain('const router = createGenericJobsRouter({');
  });

  it('owns and mounts the managed-bearer result adapter before the GPT Access fallback', async () => {
    const bearerAdapterSource = await fs.readFile(
      new URL('../src/routes/backstageBookerAsyncResult.ts', import.meta.url),
      'utf8',
    );
    const genericAdapterSource = await fs.readFile(
      new URL('../src/routes/jobs.ts', import.meta.url),
      'utf8',
    );
    const registerSource = await fs.readFile(
      new URL('../src/routes/register.ts', import.meta.url),
      'utf8',
    );
    const bearerMount = "app.use('/', backstageBookerAsyncResultRouter);";
    const genericJobsMount = "app.use('/', jobsRouter);";
    const gptAccessMount = "app.use('/', gptAccessRouter);";

    expect(bearerAdapterSource).toContain(
      'export function createBackstageBookerAsyncResultRouter(',
    );
    expect(bearerAdapterSource).toContain(
      '`${BACKSTAGE_BOOKER_ASYNC_RESULT_PATH_PREFIX}/:jobId/result`',
    );
    expect(genericAdapterSource).not.toContain(
      'createBackstageBookerAsyncResultRouter',
    );
    expect(registerSource).toContain(
      "import backstageBookerAsyncResultRouter from './backstageBookerAsyncResult.js';",
    );
    expect(registerSource.indexOf(bearerMount)).toBeGreaterThan(-1);
    expect(registerSource.indexOf(genericJobsMount)).toBeGreaterThan(-1);
    expect(registerSource.indexOf(gptAccessMount)).toBeGreaterThan(-1);
    expect(registerSource.indexOf(bearerMount))
      .toBeLessThan(registerSource.indexOf(genericJobsMount));
    expect(registerSource.indexOf(genericJobsMount))
      .toBeLessThan(registerSource.indexOf(gptAccessMount));
  });
});
