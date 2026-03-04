/**
 * Purpose: backward-compatible runtime errors export surface.
 * Inputs/Outputs: re-exports platform resilience runtime error contracts.
 * Edge cases: keeps legacy test/import paths stable after runtime layer refactor.
 */
export * from '@platform/resilience/runtimeErrors.js';
