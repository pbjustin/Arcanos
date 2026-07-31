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
});
