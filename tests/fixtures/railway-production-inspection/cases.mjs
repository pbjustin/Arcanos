/** The exact, versioned inventory required by both the inner suite and runner. */
export function requiredFixtureCases(postgresMajor) {
  if (![17, 18].includes(postgresMajor)) throw new Error('FIXTURE_POSTGRES_MAJOR_INVALID');
  return [
    'complete-catalog', 'absent-catalog', 'incomplete-catalog',
    ...(postgresMajor === 18 ? ['not-enforced-constraint'] : []),
    'metadata-drift', 'catalog-token-leak', 'catalog-password-leak', 'oversized-receipt',
    'database-untrusted', 'database-wrong-pin', 'database-different-trusted-peer',
    'database-expired-pin', 'metadata-output-limit', 'metadata-stream-timeout',
    'metadata-provider-error', 'cli-output-limit', 'cli-provider-error', 'cli-timeout',
    'trusted-main-gate', 'trusted-checkout-gate', 'exclusive-existing-receipt',
    'exclusive-symlink-receipt',
  ];
}
