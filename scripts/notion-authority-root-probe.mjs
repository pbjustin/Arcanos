/**
 * Transitional no-op retained only for stale Railway start-command fallbacks.
 *
 * Root validation and synchronization now belong exclusively to the bounded,
 * lease-fenced worker pipeline. Startup preloads must not contact Notion before
 * the Railway health listener can bind. Remove this shim only after every
 * effective and fallback service command no longer imports it.
 */
