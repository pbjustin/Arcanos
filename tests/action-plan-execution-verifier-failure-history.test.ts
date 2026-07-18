import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface FailureFixture {
  sourceCommit: string;
  postgresqlVersion: string;
  catalogArray: { expected: string[]; driverValue: string };
  checkConstraint: {
    reviewed: string;
    postgresql18: string;
    legacyReviewedHash: string;
    legacyPostgresql18Hash: string;
  };
  partialIndex: { normalizedDefinition: string };
  observedIssueCounts: {
    relationalCatalogArrayRepresentation: number;
    postgresql18CheckDeparsing: number;
    partialIndexComparison: number;
    derivedLedgerConsequences: number;
    total: number;
  };
}

const fixture = JSON.parse(readFileSync(join(
  process.cwd(),
  'tests',
  'fixtures',
  'action-plan-execution-postgres18-verifier-failure.json'
), 'utf8')) as FailureFixture;

describe('historical PostgreSQL 18 verifier failure at 8e428686', () => {
  it('preserves the three representation-sensitive false-negative mechanisms', () => {
    expect(Array.isArray(fixture.catalogArray.driverValue)).toBe(false);
    expect(fixture.catalogArray.driverValue).not.toEqual(fixture.catalogArray.expected);

    expect(fixture.checkConstraint.legacyReviewedHash).toBe(
      '70f6749c1081d98ce4ccbd59210d716d1ab1e0792b0d4137969dd586056186b9'
    );
    expect(fixture.checkConstraint.legacyPostgresql18Hash).toBe(
      'cc1ebf01767d549da19031bc175af0fd8e9061baf2a45cf1af915320beecccc3'
    );
    expect(fixture.checkConstraint.legacyPostgresql18Hash).not.toBe(
      fixture.checkConstraint.legacyReviewedHash
    );

    expect(fixture.partialIndex.normalizedDefinition.split(' where ')).toHaveLength(1);
    expect(fixture.partialIndex.normalizedDefinition).toContain(')where(');
  });

  it('keeps the observed failure count internally consistent without making it desired behavior', () => {
    const counts = fixture.observedIssueCounts;
    expect(fixture.sourceCommit).toBe('8e428686459fb11117dd04865428af58d8d819fa');
    expect(fixture.postgresqlVersion).toBe('18.4');
    expect(
      counts.relationalCatalogArrayRepresentation
      + counts.postgresql18CheckDeparsing
      + counts.partialIndexComparison
      + counts.derivedLedgerConsequences
    ).toBe(counts.total);
  });
});
