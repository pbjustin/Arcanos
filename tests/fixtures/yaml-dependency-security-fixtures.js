import { spawnSync } from 'node:child_process';

// Shared with the independent before/after verification harness. Keep all
// samples bounded: the largest merge chain is under 6 KiB and 11K key visits.
export function mergeChain(count) {
  const lines = ['a0: &a0 { k0: 0 }'];
  for (let index = 1; index < count; index += 1) {
    lines.push(`a${index}: &a${index} { <<: *a${index - 1}, k${index}: ${index} }`);
  }
  return `${lines.join('\n')}\n`;
}

export const nonEmptyMergeFixtures = [
  {
    name: 'a small nested chain', source: mergeChain(4), budget: 9,
    target: 'a3', expected: { k0: 0, k1: 1, k2: 2, k3: 3 }
  },
  {
    name: 'multiple merge levels with local overrides', budget: 9, target: 'job',
    source: 'base: &base { role: read, enabled: true }\n'
      + 'middle: &middle { <<: *base, enabled: false }\n'
      + 'job: { <<: [*middle, *base], role: write }\n',
    expected: { role: 'write', enabled: false }
  },
  {
    name: 'repeated shared nonempty aliases', budget: 6, target: 'job',
    source: 'base: &base { role: read }\njob: { <<: [*base, *base, *base] }\n',
    expected: { role: 'read' }
  }
];

export const emptyMergeFixtures = [
  { name: 'one empty mapping', source: 'job: { <<: {} }\n', budget: 1, target: 'job', expected: {} },
  {
    name: 'multiple inline empty mappings', source: 'job: { <<: [{}, {}, {}] }\n',
    budget: 3, target: 'job', expected: {}
  },
  {
    name: 'repeated aliases to one empty mapping',
    source: 'empty: &empty {}\njob: { <<: [*empty, *empty, *empty] }\n',
    budget: 3, target: 'job', expected: {}
  },
  {
    name: 'empty merges distributed across nested mappings',
    source: 'empty: &empty {}\nfirst: { <<: *empty }\n'
      + 'jobs:\n  - <<: [*empty, *empty]\n  - nested: { <<: [*empty, *empty] }\n',
    budget: 5, target: 'jobs', expected: [{}, { nested: {} }]
  }
];

export const malformedYamlFixtures = [
  ['duplicate authorization key', 'permissions:\n  contents: read\n  contents: write\n'],
  ['duplicate deployment hold', 'hold: true\nhold: false\n'],
  ['unterminated sequence', 'jobs: [validate, build\n'],
  ['unknown alias', 'job: *missing\n'],
  ['non-mapping merge source', 'job: { <<: [true] }\n'],
  ['null merge source', 'job: { <<: null }\n'],
  ['scalar merge source', 'job: { <<: unsafe }\n'],
  ['mixed valid and invalid merge sources', 'job: { <<: [{ safe: true }, 7] }\n'],
  ['malformed nested indentation', 'job:\n  permissions:\n    contents: read\n   packages: write\n'],
  ['invalid explicitly typed scalar', 'hold: !!bool perhaps\n']
];

export const orderedMapKeys = [
  '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'ordinary', '1', '01', '1.0', '-0', '0'
];

export function orderedMapSource(keys = orderedMapKeys) {
  // Quote numeric-looking identifiers so their distinct spelling is preserved.
  return `!!omap\n${keys.map((key, index) => `- ${JSON.stringify(key)}: ${index}`).join('\n')}\n`;
}

export function measureOrderedMapWork(modulePath) {
  // A separate process keeps the advisory-specific instrumentation away from
  // Jest and other consumers; no host-speed or wall-clock performance assertion.
  return spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
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
}
