/** The exact, versioned inventory required by both the inner suite and runner. */
export function requiredFixtureCases(postgresMajor) {
  if (![17, 18].includes(postgresMajor)) throw new Error('FIXTURE_POSTGRES_MAJOR_INVALID');
  return [
    'complete-catalog', 'absent-catalog', 'incomplete-catalog',
    ...(postgresMajor === 18 ? ['not-enforced-constraint'] : []),
    'metadata-drift', 'catalog-token-leak', 'catalog-password-leak', 'oversized-receipt',
    'database-untrusted', 'database-wrong-pin', 'database-different-trusted-peer',
    'database-issuer-signed-pin', 'database-template-signed-pin',
    'database-same-issuer-different-peer', 'database-expired-pin', 'database-future-pin',
    'database-malformed-pin', 'database-bundle-pin', 'project-token-missing', 'project-token-incorrect',
    'database-credentials-missing', 'database-authentication-failure', 'database-target-mismatch',
    'database-tls-downgrade', 'database-connection-refused',
    'database-query-error-aborted-transaction', 'database-query-timeout',
    'database-connection-loss', 'database-cleanup-timeout', 'collector-interrupted',
    'metadata-output-limit', 'metadata-stream-timeout',
    'metadata-provider-error', 'cli-output-limit', 'cli-provider-error', 'cli-timeout',
    'trusted-main-gate', 'trusted-checkout-gate', 'exclusive-existing-receipt',
    'exclusive-symlink-receipt',
  ];
}

/** Identify cases which intentionally cannot create a new collector receipt. */
export function fixtureCaseWritesReceipt(name) {
  return !['trusted-main-gate', 'trusted-checkout-gate', 'exclusive-existing-receipt',
    'exclusive-symlink-receipt', 'collector-interrupted'].includes(name);
}
