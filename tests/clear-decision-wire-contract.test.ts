import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  CLEAR2_DECISION_THRESHOLDS,
  interpretClear2Outcome,
} from '../src/services/clearDecision.js';

type WireContractCase = {
  name: string;
  evaluation: unknown;
  expected: Record<string, unknown>;
};

type WireContract = {
  version: number;
  thresholds: {
    confirmMinimum: number;
    allowMinimum: number;
  };
  cases: WireContractCase[];
};

const contract = JSON.parse(readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'clear-decision-wire-contract.json'),
  'utf8',
)) as WireContract;

describe('cross-language CLEAR wire contract', () => {
  it('records the authoritative threshold values and unique deterministic case names', () => {
    expect(contract.version).toBe(1);
    expect(contract.thresholds).toEqual(CLEAR2_DECISION_THRESHOLDS);
    expect(new Set(contract.cases.map(testCase => testCase.name)).size).toBe(contract.cases.length);
  });

  it.each(contract.cases)('$name', ({ evaluation, expected }) => {
    expect(interpretClear2Outcome(evaluation)).toEqual(expected);
  });
});
