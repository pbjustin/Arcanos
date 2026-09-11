/**
 * Transitional no-op retained only for stale Railway start-command fallbacks.
 *
 * Database-container roots are first-class inputs to the authoritative Notion
 * synchronization pipeline. This compatibility preload must not install a
 * second root adapter, wrap global fetch, or mutate NODE_OPTIONS. Remove the
 * shim only after every effective and fallback Railway command stops importing
 * it.
 */
