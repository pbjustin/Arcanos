import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ts from 'typescript';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const WORKER_ROOT = path.resolve(process.cwd(), 'workers');
const REDIS_LIFECYCLE_PATH = 'platform/runtime/redisLifecycle.ts';

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(resolved));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(resolved);
    }
  }
  return files;
}

function relativeSourcePath(filePath: string): string {
  return path.relative(SOURCE_ROOT, filePath).replaceAll('\\', '/');
}

describe('Redis operation source boundary', () => {
  const sourceFiles = listTypeScriptFiles(SOURCE_ROOT);

  it('keeps client creation and the redis package import in the lifecycle adapter only', () => {
    const redisImports: string[] = [];
    const clientFactories: string[] = [];
    const duplicateCalls: string[] = [];

    for (const filePath of sourceFiles) {
      const relativePath = relativeSourcePath(filePath);
      const source = fs.readFileSync(filePath, 'utf8');
      if (/\bfrom\s+['"]redis['"]|\brequire\(\s*['"]redis['"]\s*\)/u.test(source)) {
        redisImports.push(relativePath);
      }
      if (/\bcreateClient\s*\(/u.test(source)) {
        clientFactories.push(relativePath);
      }
      if (/\.duplicate\s*\(/u.test(source)) {
        duplicateCalls.push(relativePath);
      }
    }

    expect(redisImports).toEqual([REDIS_LIFECYCLE_PATH]);
    expect(clientFactories).toEqual([REDIS_LIFECYCLE_PATH]);
    expect(duplicateCalls).toEqual([]);
  });

  it('requires an explicit operation identity at every application gate call', () => {
    const missingOperation: string[] = [];
    let gateCallCount = 0;
    const inferenceOperations: string[] = [];
    const previewOperations: string[] = [];

    for (const filePath of sourceFiles) {
      if (relativeSourcePath(filePath) === REDIS_LIFECYCLE_PATH) {
        continue;
      }
      const source = fs.readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'executeRedisOperation'
        ) {
          gateCallCount += 1;
          const options = node.arguments[1];
          const hasOperation = Boolean(
            options
            && ts.isObjectLiteralExpression(options)
            && options.properties.some((property) => (
              (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
              && property.name.getText(sourceFile) === 'operation'
            ))
          );
          if (!hasOperation) {
            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            missingOperation.push(
              `${relativeSourcePath(filePath)}:${location.line + 1}`
            );
          }
          const identities = relativeSourcePath(filePath) === 'services/selfImprove/selfHealingInferenceAdmission.ts'
            ? inferenceOperations : relativeSourcePath(filePath) === 'services/selfImprove/selfHealingPreviewControl.ts'
              ? previewOperations : undefined;
          if (identities && options && ts.isObjectLiteralExpression(options)) {
            const identity = options.properties.find(property => ts.isPropertyAssignment(property)
              && property.name.getText(sourceFile) === 'operation');
            if (identity && ts.isPropertyAssignment(identity)) {
              identities.push(identity.initializer.getText(sourceFile));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    // The original sixteen gates include the sealed CLIENT ID read. Shared
    // inference adds exactly two: the durable ledger/time read and atomic CAS.
    // The PR 1557 preview adds one read-only GET/PTTL/TIME ledger observation.
    // All remain inside the lifecycle gate with fixed allowlisted identities.
    expect(gateCallCount).toBe(19);
    expect(inferenceOperations).toEqual(["'self_heal.inference.reserve'", "'self_heal.inference.complete'"]);
    expect(previewOperations).toEqual(["'diagnostics.metrics.read'", "'diagnostics.metrics.read'"]);
    expect(missingOperation).toEqual([]);
  });

  it('keeps the sealed shutdown identity read on the lifecycle operation gate', () => {
    const previewSource = fs.readFileSync(path.join(SOURCE_ROOT,
      'services/selfImprove/selfHealingPreviewControl.ts'), 'utf8');
    expect(previewSource).toContain("executeRedisOperation(client => client.sendCommand(['CLIENT', 'ID']),");
    expect(previewSource).toContain("{ operation: 'diagnostics.metrics.read', timeoutMs: 500 }");
  });

  it('does not export raw lifecycle clients to application code', () => {
    const lifecycleSource = fs.readFileSync(
      path.join(SOURCE_ROOT, REDIS_LIFECYCLE_PATH),
      'utf8'
    );
    const safetyRedisSource = fs.readFileSync(
      path.join(SOURCE_ROOT, 'services/safety/v2/redisClient.ts'),
      'utf8'
    );

    expect(lifecycleSource).not.toMatch(
      /export\s+function\s+(?:getReadyRedisClient|requireReadyRedisClient)\b/u
    );
    expect(safetyRedisSource).not.toMatch(
      /export\s+async\s+function\s+getRedis\b/u
    );

    const sourceFile = ts.createSourceFile(
      REDIS_LIFECYCLE_PATH,
      lifecycleSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const managerMethods: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isClassDeclaration(node)
        && node.name?.text === 'RedisLifecycleManager'
      ) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            managerMethods.push(member.name.getText(sourceFile));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(managerMethods).not.toContain('getReadyClient');
    expect(managerMethods).not.toContain('reportUnavailable');
  });

  it('drives public-provider capability readiness from lifecycle generations only', () => {
    const serverSource = fs.readFileSync(
      path.join(SOURCE_ROOT, 'server.ts'),
      'utf8'
    );
    const healthSource = fs.readFileSync(
      path.join(SOURCE_ROOT, 'platform/resilience/unifiedHealth.ts'),
      'utf8'
    );
    const observerCalls = serverSource.match(
      /observePublicProviderRateLimitRedisLifecycle\(/gu
    ) ?? [];

    expect(observerCalls).toHaveLength(2);
    expect(serverSource).toContain(
      'observePublicProviderRateLimitRedisLifecycle(initialRedisSnapshot)'
    );
    expect(healthSource).toContain('getPublicProviderRateLimitReadinessSnapshot()');
    expect(healthSource).not.toMatch(
      /checkPublicProviderAdmissionReadiness[\s\S]{0,1200}executeRedisOperation/u
    );
  });

  it('keeps the standalone AI runtime outside Railway web and worker entrypoints', () => {
    const deploymentFiles = [
      ...sourceFiles,
      ...listTypeScriptFiles(WORKER_ROOT),
      path.resolve(process.cwd(), 'scripts/start-railway-service.mjs')
    ];
    const runtimeImports = deploymentFiles
      .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('arcanos-ai-runtime'))
      .map((filePath) => path.relative(process.cwd(), filePath).replaceAll('\\', '/'));
    const launcherSource = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/start-railway-service.mjs'),
      'utf8'
    );
    const standalonePackage = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), 'arcanos-ai-runtime/package.json'),
      'utf8'
    )) as { name?: string };

    expect(runtimeImports).toEqual([]);
    expect(launcherSource).toContain("'dist/start-server.js'");
    expect(launcherSource).toContain("'dist/workers/jobRunner.js'");
    expect(standalonePackage.name).toBe('arcanos-ai-runtime');
  });
});
