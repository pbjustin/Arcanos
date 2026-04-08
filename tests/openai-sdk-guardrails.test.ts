import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ['src', 'packages', 'tests'];
const SELF_FILE = path.resolve(REPO_ROOT, 'tests', 'openai-sdk-guardrails.test.ts');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ALLOWED_OPENAI_CONSTRUCTORS = new Set([
  path.resolve(REPO_ROOT, 'packages', 'arcanos-openai', 'src', 'client.ts'),
  path.resolve(REPO_ROOT, 'src', 'core', 'adapters', 'openai.adapter.ts'),
]);

const FORBIDDEN_PATTERNS = [
  {
    label: 'responses.parse',
    regex: /\bresponses\.parse\s*\(/,
  },
  {
    label: 'chat.completions.parse',
    regex: /\bchat\.completions\.parse\s*\(/,
  },
  {
    label: '_thenUnwrap',
    regex: /\b_thenUnwrap\b/,
  },
] as const;

function collectSourceFiles(rootPath: string): string[] {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const discovered: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...collectSourceFiles(entryPath));
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      discovered.push(entryPath);
    }
  }

  return discovered;
}

describe('openai sdk guardrails', () => {
  it('does not allow private SDK helper usage patterns back into the repo', () => {
    const violations: string[] = [];

    for (const scanRoot of SCAN_ROOTS) {
      const rootPath = path.resolve(REPO_ROOT, scanRoot);
      if (!fs.existsSync(rootPath)) {
        continue;
      }

      for (const filePath of collectSourceFiles(rootPath)) {
        if (path.resolve(filePath) === SELF_FILE) {
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.regex.test(content)) {
            violations.push(`${path.relative(REPO_ROOT, filePath)} => ${pattern.label}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('only allows raw OpenAI SDK construction at approved adapter boundaries', () => {
    const violations: string[] = [];

    for (const scanRoot of SCAN_ROOTS) {
      const rootPath = path.resolve(REPO_ROOT, scanRoot);
      if (!fs.existsSync(rootPath)) {
        continue;
      }

      for (const filePath of collectSourceFiles(rootPath)) {
        if (path.resolve(filePath) === SELF_FILE) {
          continue;
        }

        const resolvedPath = path.resolve(filePath);
        if (ALLOWED_OPENAI_CONSTRUCTORS.has(resolvedPath)) {
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        if (/\bnew OpenAI\s*\(/.test(content)) {
          violations.push(path.relative(REPO_ROOT, filePath));
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
