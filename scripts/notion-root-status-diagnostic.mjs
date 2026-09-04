/**
 * Transitional no-op retained only for stale Railway start-command fallbacks.
 *
 * Production synchronization emits bounded structured lifecycle events. A
 * preload must not wrap global fetch, propagate itself through NODE_OPTIONS,
 * or observe provider responses. Remove this shim after all Railway commands
 * have converged on the canonical integrity wrapper.
 */
