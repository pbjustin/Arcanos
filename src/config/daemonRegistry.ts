/**
 * Daemon registry configuration for the daemon API.
 */

export const DAEMON_REGISTRY_VERSION = 1;

export const DAEMON_REGISTRY_ENDPOINTS = [
  {
    path: '/api/ask',
    method: 'POST',
    description: 'Core logic, module routing, daemon tools'
  },
  {
    path: '/api/vision',
    method: 'POST',
    description: 'Image analysis'
  },
  {
    path: '/api/transcribe',
    method: 'POST',
    description: 'Audio transcription'
  },
  {
    path: '/api/daemon/commands',
    method: 'GET',
    description: 'Daemon poll for commands'
  },
  {
    path: '/api/daemon/confirm-actions',
    method: 'POST',
    description: 'Confirm and queue sensitive daemon actions'
  }
];

export const DAEMON_REGISTRY_TOOLS = [
  {
    name: 'run_command',
    description: 'Run a command on the user machine',
    sensitive: true
  },
  {
    name: 'capture_screen',
    description: 'Capture screen or camera',
    sensitive: false
  }
];

export const DAEMON_REGISTRY_CORE = [
  {
    id: 'CLEAR 2.0',
    description: 'Audit engine'
  },
  {
    id: 'HRC',
    description: 'Hallucination-Resistant Core',
    modes: ['HRC:STRICT', 'HRC:LENIENT', 'HRC:SILENTFAIL', 'HRC->CLEAR']
  }
];
