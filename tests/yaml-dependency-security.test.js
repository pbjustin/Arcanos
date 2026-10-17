import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  emptyMergeFixtures, malformedYamlFixtures, measureOrderedMapWork, mergeChain,
  nonEmptyMergeFixtures, orderedMapKeys, orderedMapSource
} from './fixtures/yaml-dependency-security-fixtures.js';

const require = createRequire(import.meta.url);
const nycRequire = createRequire(require.resolve('@istanbuljs/load-nyc-config'));
const parsers = [
  ['direct tooling', require.resolve('js-yaml'), require('js-yaml')],
  ['NYC configuration tooling', nycRequire.resolve('js-yaml'), nycRequire('js-yaml')]
];
const workflowDirectory = path.join(process.cwd(), '.github/workflows');
const workflows = readdirSync(workflowDirectory).filter(file => /\.ya?ml$/u.test(file)).sort();

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

  it.each(malformedYamlFixtures)('rejects %s', (_case, source) => {
    expect(() => yaml.load(source)).toThrow(yaml.YAMLException);
  });

  it('preserves scalar types without treating quoted strings as configuration flags', () => {
    expect(yaml.load('values: [true, false, null, 42, 3.5, "42", "false", "null"]\n')).toEqual({
      values: [true, false, null, 42, 3.5, '42', 'false', 'null']
    });
  });

  it.each(nonEmptyMergeFixtures)('bounds $name with an inclusive work limit', ({ source, budget, target, expected }) => {
    // Each merge costs one source plus its keys after GHSA-2883-xcg3-v3hh;
    // older GHSA-52cp-r559-cp3m fixes counted only keys for nonempty sources.
    expect(yaml.load(source, { maxTotalMergeKeys: budget })[target]).toEqual(expected);
    expect(yaml.load(source, { maxTotalMergeKeys: budget + 1 })[target]).toEqual(expected);
    expect(() => yaml.load(source, { maxTotalMergeKeys: budget - 1 })).toThrow(/maxTotalMergeKeys/u);
  });

  it('enforces the default merge budget without a caller override (GHSA-52cp-r559-cp3m)', () => {
    // Fewer than 6 KiB of input and about 10K key visits; no large DoS fixture.
    const source = mergeChain(145);
    expect(Buffer.byteLength(source)).toBeLessThan(6 * 1024);
    expect(() => yaml.load(source)).toThrow(/maxTotalMergeKeys/u);
  });

  it('honors an explicit higher merge budget and its exact boundary', () => {
    const source = mergeChain(145);
    // 2 + 3 + ... + 145 source/key units = 10584.
    const parsed = yaml.load(source, { maxTotalMergeKeys: 10584 });
    expect(Object.keys(parsed.a144)).toHaveLength(145);
    expect(parsed.a144.k0).toBe(0);
    expect(parsed.a144.k144).toBe(144);
    expect(() => yaml.load(source, { maxTotalMergeKeys: 10583 })).toThrow(/maxTotalMergeKeys/u);
  });

  it('charges empty merge sources across the entire document (GHSA-2883-xcg3-v3hh)', () => {
    const source = 'sources: &sources [{}, {}]\ntargets:\n  - <<: *sources\n  - <<: *sources\n';
    expect(yaml.load(source, { maxTotalMergeKeys: 4 }).targets).toEqual([{}, {}]);
    expect(() => yaml.load(source, { maxTotalMergeKeys: 3 })).toThrow(/maxTotalMergeKeys/u);
  });

  it.each(emptyMergeFixtures)('charges $name against the global merge budget', ({ source, budget, target, expected }) => {
    expect(yaml.load(source, { maxTotalMergeKeys: budget })[target]).toEqual(expected);
    expect(yaml.load(source, { maxTotalMergeKeys: budget + 1 })[target]).toEqual(expected);
    expect(() => yaml.load(source, { maxTotalMergeKeys: budget - 1 })).toThrow(/maxTotalMergeKeys/u);
  });

  it('preserves ordered maps and rejects duplicate prototype-like keys (GHSA-5p4m-2wfm-xmqj)', () => {
    const keys = orderedMapKeys;
    const source = orderedMapSource();
    const ordered = yaml.load(source);
    expect(ordered.map(pair => Object.keys(pair)[0])).toEqual(keys);
    for (const [index, key] of keys.entries()) {
      expect(Object.hasOwn(ordered[index], key)).toBe(true);
      expect(ordered[index][key]).toBe(index);
      expect(() => yaml.load(`${source}- ${JSON.stringify(key)}: duplicate\n`)).toThrow(yaml.YAMLException);
    }
  });

  it.each([
    ['a multi-key ordered-map entry', '!!omap\n- { one: 1, two: 2 }\n'],
    ['a scalar ordered-map entry', '!!omap\n- ordinary\n'],
    ['an empty ordered-map entry', '!!omap\n- {}\n']
  ])('rejects %s', (_case, source) => {
    expect(() => yaml.load(source)).toThrow(yaml.YAMLException);
  });

  it('avoids quadratic ordered-map key scans without a timing assertion (GHSA-5p4m-2wfm-xmqj)', () => {
    // Isolate instrumentation from Jest and all other consumers. Count work in
    // the advisory's Array#indexOf key scan, rather than measuring host speed.
    const child = measureOrderedMapWork(modulePath);
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
