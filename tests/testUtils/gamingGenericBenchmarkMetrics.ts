export interface GamingBenchmarkObservation {
  id: string;
  expected: 'accept' | 'reject';
  accepted: boolean;
  securityCritical: boolean;
  diagnosticCovered: boolean;
  selectedContamination: boolean;
  reasonCodes: string[];
}

/** Two-sided Wilson score interval, z=1.959963984540054 (nominal 95%). */
export function gamingBenchmarkWilson95(successes: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const divisor = 1 + z * z / total;
  const centre = (proportion + z * z / (2 * total)) / divisor;
  const margin = z / divisor * Math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total));
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

export function summarizeGamingGenericBenchmark(observations: readonly GamingBenchmarkObservation[]) {
  const valid = observations.filter(item => item.expected === 'accept');
  const invalid = observations.filter(item => item.expected === 'reject');
  const acceptedValid = valid.filter(item => item.accepted).length;
  const rejectedInvalid = invalid.filter(item => !item.accepted).length;
  const covered = observations.filter(item => item.diagnosticCovered).length;
  return {
    samples: observations.length,
    valid: { denominator: valid.length, accepted: acceptedValid, rejected: valid.length - acceptedValid,
      acceptanceRate: acceptedValid / valid.length, falseNegativeRate: (valid.length - acceptedValid) / valid.length,
      acceptanceWilson95: gamingBenchmarkWilson95(acceptedValid, valid.length) },
    invalid: { denominator: invalid.length, rejected: rejectedInvalid, accepted: invalid.length - rejectedInvalid,
      rejectionRate: rejectedInvalid / invalid.length, falsePositiveRate: (invalid.length - rejectedInvalid) / invalid.length,
      rejectionWilson95: gamingBenchmarkWilson95(rejectedInvalid, invalid.length) },
    diagnostics: { denominator: observations.length, covered, coverageRate: covered / observations.length },
    securityCriticalAccepted: observations.filter(item => item.expected === 'reject' && item.securityCritical && item.accepted).map(item => item.id),
    contaminatedSelection: observations.filter(item => item.selectedContamination).map(item => item.id),
    falseNegatives: valid.filter(item => !item.accepted).map(item => ({ id: item.id, reasonCodes: item.reasonCodes })),
    falsePositives: invalid.filter(item => item.accepted).map(item => ({ id: item.id, reasonCodes: item.reasonCodes }))
  };
}
