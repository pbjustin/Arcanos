import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nycRequire = createRequire(require.resolve('@istanbuljs/load-nyc-config'));
const parsers = [
  ['direct tooling', require.resolve('js-yaml'), require('js-yaml')],
  ['NYC configuration tooling', nycRequire.resolve('js-yaml'), nycRequire('js-yaml')]
];
const workflowDirectory = path.join(process.cwd(), '.github/workflows');
const workflows = readdirSync(workflowDirectory).filter(file => /\.ya?ml$/u.test(file)).sort();

function mergeChain(count) {
  const lines = ['a0: &a0 { k0: 0 }'];
  for (let index = 1; index < count; index += 1) {
    lines.push(`a${index}: &a${index} { <<: *a${index - 1}, k${index}: ${index} }`);
  }
  return `${lines.join('\n')}\n`;
}

describe.each(parsers)('%s YAML dependency security', (_name, modulePath, yaml) => {
  it('preserves nested configuration, quoted scalars, and ordinary aliases', () => {
    const configuration = yaml.load(`
defaults: &defaults
  hold: true
  environment: production
jobs:
  - <<: *defaults
    name: web
    enabled: false
    quoted: "false"
    special: 'value: # literal & * !'
    steps: [validate, "build:test"]
  - <<: *defaults
    name: worker
    environment: preview
description: |-
  Keep deployment holds.
  Validate before release.
`);
    expect(configuration.jobs).toEqual([
      { hold: true, environment: 'production', name: 'web', enabled: false,
        quoted: 'false', special: 'value: # literal & * !', steps: ['validate', 'build:test'] },
      { hold: true, environment: 'preview', name: 'worker' }
    ]);
    expect(configuration.description).toBe('Keep deployment holds.\nValidate before release.');
    expect(yaml.load(yaml.dump(configuration))).toEqual(configuration);
  });

  it.each([
    ['duplicate authorization key', 'permissions:\n  contents: read\n  contents: write\n'],
    ['unterminated sequence', 'jobs: [validate, build\n'],
    ['unknown alias', 'job: *missing\n'],
    ['non-mapping merge source', 'job: { <<: [true] }\n']
  ])('rejects %s', (_case, source) => {
    expect(() => yaml.load(source)).toThrow(yaml.YAMLException);
  });

  it('bounds merge-key chains with the configured inclusive work limit (GHSA-52cp-r559-cp3m)', () => {
    const source = mergeChain(4);
    // The three merges cost (one source + its keys): 2 + 3 + 4 = 9 units.
    expect(yaml.load(source, { maxTotalMergeKeys: 9 }).a3).toEqual({ k0: 0, k1: 1, k2: 2, k3: 3 });
    expect(() => yaml.load(source, { maxTotalMergeKeys: 8 })).toThrow(/maxTotalMergeKeys/u);
  });

  it('enforces the default merge budget without a caller override (GHSA-52cp-r559-cp3m)', () => {
    // Fewer than 6 KiB of input and about 10K key visits; no large DoS fixture.
    const source = mergeChain(145);
    expect(Buffer.byteLength(source)).toBeLessThan(6 * 1024);
    expect(() => yaml.load(source)).toThrow(/maxTotalMergeKeys/u);
  });

  it('charges empty merge sources across the entire document (GHSA-2883-xcg3-v3hh)', () => {
    const source = 'sources: &sources [{}, {}]\ntargets:\n  - <<: *sources\n  - <<: *sources\n';
    expect(yaml.load(source, { maxTotalMergeKeys: 4 }).targets).toEqual([{}, {}]);
    expect(() => yaml.load(source, { maxTotalMergeKeys: 3 })).toThrow(/maxTotalMergeKeys/u);
  });

  it('preserves ordered maps and rejects duplicate prototype-like keys (GHSA-5p4m-2wfm-xmqj)', () => {
    const keys = ['__proto__', 'constructor', 'toString', 'ordinary'];
    const source = `!!omap\n${keys.map((key, index) => `- ${key}: ${index}`).join('\n')}\n`;
    const ordered = yaml.load(source);
    expect(ordered.map(pair => Object.keys(pair)[0])).toEqual(keys);
    for (const [index, key] of keys.entries()) {
      expect(Object.hasOwn(ordered[index], key)).toBe(true);
      expect(ordered[index][key]).toBe(index);
      expect(() => yaml.load(`${source}- ${key}: duplicate\n`)).toThrow(yaml.YAMLException);
    }
  });

  it('avoids quadratic ordered-map key scans without a timing assertion (GHSA-5p4m-2wfm-xmqj)', () => {
    // Isolate instrumentation from Jest and all other consumers. Count work in
    // the advisory's Array#indexOf key scan, rather than measuring host speed.
    const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
      const yaml = require(process.argv[1]);
      const indexOf = Array.prototype.indexOf;
      const prefix = 'arcanos_omap_security_';
      let comparisons = 0;
      Array.prototype.indexOf = function (value, fromIndex) {
        if (typeof value === 'string' && value.startsWith(prefix)) comparisons += this.length;
        return indexOf.call(this, value, fromIndex);
      };
      try {
        const results = [128, 256].map(count => {
          const source = '!!omap\\n' + Array.from({ length: count },
            (_, index) => '- ' + prefix + index + ': ' + index).join('\\n') + '\\n';
          comparisons = 0;
          const parsed = yaml.load(source);
          return { count, comparisons, length: parsed.length, last: parsed[count - 1][prefix + (count - 1)] };
        });
        process.stdout.write(JSON.stringify(results));
      } finally {
        Array.prototype.indexOf = indexOf;
      }
    `, modulePath], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
      status: 0, error: undefined, stderr: ''
    });
    for (const result of JSON.parse(child.stdout)) {
      expect(result.length).toBe(result.count);
      expect(result.last).toBe(result.count - 1);
      // Allows bounded linear scans, but rejects n(n-1)/2 duplicate-key work.
      expect(result.comparisons).toBeLessThanOrEqual(4 * result.count);
    }
  });

  it.each(workflows)('parses the checked-in GitHub Actions workflow %s', file => {
    const workflow = yaml.load(readFileSync(path.join(workflowDirectory, file), 'utf8'));
    expect(typeof workflow.name).toBe('string');
    expect(Object.hasOwn(workflow, 'on')).toBe(true);
    expect(workflow.jobs).toBeDefined();
    expect(typeof workflow.jobs).toBe('object');
    expect(Array.isArray(workflow.jobs)).toBe(false);
    expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
  });
});
