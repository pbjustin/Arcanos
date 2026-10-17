import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createUpdatedFixture } from './helpers/tutor-updated-release-fixture.js';

const require = createRequire(import.meta.url);
const { Legacy: { ConfigArrayFactory } } = require('@eslint/eslintrc');
const { loadNycConfig } = require('@istanbuljs/load-nyc-config');
const roots = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-yaml-consumer-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-yaml-consumer-')) {
      throw new Error('Unexpected temporary fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('installed ESLint legacy YAML configuration consumer', () => {
  it('loads aliases, nested settings and typed rules through ConfigArrayFactory', () => {
    const root = fixture();
    const file = path.join(root, '.eslintrc.yaml');
    writeFileSync(file, `root: true
env: { node: true }
parserOptions: { ecmaVersion: 2022, sourceType: module }
settings:
  defaults: &defaults { enabled: false, label: "false", special: 'value: # & * !' }
  selected: { <<: *defaults, enabled: true, values: [1, "1", false] }
rules:
  no-unused-vars: [warn, { args: none }]
`);
    const configuration = new ConfigArrayFactory({ cwd: root }).loadFile(file)
      .extractConfig(path.join(root, 'example.js'));
    expect(configuration.env).toEqual({ node: true });
    expect(configuration.parserOptions).toEqual({ ecmaVersion: 2022, sourceType: 'module' });
    expect(configuration.settings.selected).toEqual({ enabled: true, label: 'false',
      special: 'value: # & * !', values: [1, '1', false] });
    expect(configuration.rules['no-unused-vars']).toEqual(['warn', { args: 'none' }]);
  });

  it.each([
    ['duplicate security setting', 'root: true\nroot: false\n', /duplicated mapping key/u],
    ['invalid scalar type', 'root: "false"\n', /wrong type/u],
    ['undefined alias', 'settings: *missing\n', /unidentified alias/u],
    ['malformed sequence', 'rules: { no-unused-vars: [warn }\n', /flow collection/u]
  ])('rejects %s through the real configuration loader', (_name, source, error) => {
    const root = fixture();
    const file = path.join(root, '.eslintrc.yaml');
    writeFileSync(file, source);
    expect(() => new ConfigArrayFactory({ cwd: root }).loadFile(file)).toThrow(error);
  });
});

describe('installed Istanbul/NYC YAML configuration consumers', () => {
  it('loads extended YAML and preserves scalar types and array normalization', async () => {
    const root = fixture();
    writeFileSync(path.join(root, 'base.yaml'), 'all: false\ncheck-coverage: true\nbranches: 87\nextension: .js\n');
    writeFileSync(path.join(root, '.nycrc.yaml'), `extends: ./base.yaml
reporter: [json, text]
include: &sources ["src/**/*.js"]
exclude: ["**/*.test.js"]
report-dir: "coverage: # literal"
`);
    await expect(loadNycConfig({ cwd: root })).resolves.toEqual({ cwd: root, all: false,
      checkCoverage: true, branches: 87, extension: ['.js'], reporter: ['json', 'text'],
      include: ['src/**/*.js'], exclude: ['**/*.test.js'], reportDir: 'coverage: # literal' });
  });

  it.each([
    ['duplicate output field', 'report-dir: safe\nreport-dir: other\n', /duplicated mapping key/u],
    ['invalid extends type', 'extends: true\n', /invalid 'extends' option/u],
    ['undefined alias', 'include: *missing\n', /unidentified alias/u],
    ['malformed sequence', 'include: ["*.js"\n', /flow collection/u]
  ])('rejects %s through loadNycConfig', async (_name, source, error) => {
    const root = fixture();
    writeFileSync(path.join(root, '.nycrc.yaml'), source);
    await expect(loadNycConfig({ cwd: root })).rejects.toThrow(error);
  });

  it('honors YAML includes and excludes through Babel Istanbul instrumentation', () => {
    const root = fixture();
    writeFileSync(path.join(root, '.nycrc.yaml'), 'include: ["*.js"]\nexclude: ["excluded.js"]\n');
    const babel = require('@babel/core');
    const plugin = require.resolve('babel-plugin-istanbul');
    const source = 'module.exports = value => value ? "yes" : "no";';
    const transform = (name) => babel.transformSync(source, {
      filename: path.join(root, name), babelrc: false, configFile: false,
      plugins: [[plugin, { cwd: root, nycrcPath: '.nycrc.yaml' }]]
    }).code;
    const included = transform('included.js');
    const context = { module: { exports: (value) => String(value) },
      __coverage__: {} };
    runInNewContext(included, context);
    expect(context.module.exports(true)).toBe('yes');
    expect(context.module.exports(false)).toBe('no');
    const coverage = context.__coverage__[path.join(root, 'included.js')];
    expect(coverage).toBeDefined();
    expect(Object.values(coverage.b)).toContainEqual([1, 1]);
    expect(transform('excluded.js')).not.toContain('cov_');
  });
});

describe('real Tutor artifact frontmatter validation', () => {
  it.each([
    ['quoted special characters', 'name: arcanos-tutor\ndescription: "false: # & * !"', null],
    ['small merge alias', '<<: &metadata { name: arcanos-tutor, description: "Quoted: description" }', null],
    ['duplicate identity', 'name: arcanos-tutor\nname: other\ndescription: Mock description.', 'duplicated mapping key'],
    ['unexpected scalar type', 'name: arcanos-tutor\ndescription: false', 'UPDATED_SKILL_METADATA_INVALID'],
    ['undefined alias', 'name: arcanos-tutor\ndescription: *missing', 'unidentified alias'],
    ['unexpected metadata field', 'name: arcanos-tutor\ndescription: Mock description.\npermissions: write', 'UPDATED_SKILL_METADATA_INVALID']
  ])('validates %s through inspectUpdatedTutorBundle', (_name, metadata, error) => {
    const root = fixture();
    const content = `---\n${metadata}\n---\nSynthetic tutoring fixture only.\n`;
    const bundle = createUpdatedFixture(root, content);
    const helper = pathToFileURL(path.join(process.cwd(), 'scripts/tutor-updated-plugin-release.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { inspectUpdatedTutorBundle } from ${JSON.stringify(helper)};
      try {
        const result = await inspectUpdatedTutorBundle(JSON.parse(process.argv[1]));
        process.stdout.write(JSON.stringify(result));
      } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
    `, JSON.stringify({ bundleRoot: bundle.bundle, expectedSkillSha256: bundle.release.approvedSkillSha256 })],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(child.error).toBeUndefined();
    if (error) {
      expect(child.status).toBe(1);
      expect(child.stderr).toContain(error);
    } else {
      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({ sourceValidation: 'PASS', provenance: 'LOCAL_BYTES_ONLY',
        appOptional: true, skillCount: 1, skillSha256: bundle.release.approvedSkillSha256 });
    }
  });
});
