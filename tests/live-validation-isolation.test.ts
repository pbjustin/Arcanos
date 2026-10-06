import { describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { createGamingTokenVerifier } from '../src/chatgpt/gamingAuth.js';

describe('live validation and production separation', () => {
  it('production Gaming OAuth rejects the validation bearer before key resolution', async () => {
    const keyResolver = jest.fn<NonNullable<Parameters<typeof createGamingTokenVerifier>[1]>['keyResolver']>();
    const verify = createGamingTokenVerifier({ status: 'ready', issuer: 'https://oauth.example.com',
      resource: 'https://backend.example.com/chatgpt/gaming/mcp', jwksUrl: 'https://oauth.example.com/jwks',
      metadataUrl: 'https://backend.example.com/.well-known/oauth-protected-resource/chatgpt/gaming/mcp',
      ownerSubject: 'owner', autoStoreApproved: false }, { keyResolver, readEnvironmentValue: () => 'true' });
    expect(await verify('Bearer ' + 'a'.repeat(64))).toEqual({ ok: false, error: 'invalid_token', status: 401 });
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it('production and sealed preview import graphs contain no validation auth, adapter or launcher', async () => {
    const root = path.resolve('src');
    const queued = ['app.ts', 'start-server.ts', 'nativePrPreviewApplication.ts', 'start-native-pr-preview.ts']
      .map(file => path.join(root, file));
    const visited = new Set<string>();
    const aliases = [['@core/lib/', 'lib/'], ['@core/', 'core/'], ['@platform/', 'platform/'],
      ['@services/', 'services/'], ['@shared/', 'shared/'], ['@transport/', 'transport/']] as const;
    while (queued.length) {
      const file = queued.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, 'utf8');
      expect(source).not.toContain('ARCANOS_LIVE_VALIDATION_TEST_TOKEN');
      expect(source).not.toContain('liveValidationGamingAdapter');
      expect(source).not.toContain('start-live-validation-runtime');
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const add = (specifier: string) => {
        const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
        const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier)
          : alias ? path.resolve(root, alias[1], specifier.slice(alias[0].length)) : undefined;
        if (resolved?.endsWith('.js') && resolved.startsWith(root + path.sep)) queued.push(resolved.slice(0, -3) + '.ts');
      };
      const walk = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
          && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
        ts.forEachChild(node, walk);
      };
      walk(parsed);
    }
    expect(visited.size).toBeGreaterThan(100);
  }, 30_000);
});
