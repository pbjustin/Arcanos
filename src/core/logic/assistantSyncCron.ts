/**
 * Automatic assistant-registry synchronization is intentionally retired.
 *
 * Provider enumeration is available only through the authenticated,
 * challenge-confirmed `POST /api/assistants/sync` control-plane operation.
 * This compatibility module remains side-effect free for historical imports.
 */
export const assistantRegistryAutomaticSyncEnabled = false;
