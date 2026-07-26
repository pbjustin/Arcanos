/**
 * Canonical non-secret partition used by the daemon store for new instances.
 *
 * Historical store entries can contain other opaque values. Those values are
 * compatibility-only partition keys and must never be treated as credentials,
 * attached to request context, logged, or returned to callers.
 */
export const DAEMON_STORE_PARTITION = 'anonymous-daemon';
