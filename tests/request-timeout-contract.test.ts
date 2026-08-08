import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@jest/globals';

import { config } from '../src/platform/runtime/config.js';

const backendConfigSource = readFileSync(
  new URL('../src/platform/runtime/config.ts', import.meta.url),
  'utf8',
);
const backendCoreEnvironmentExample = readFileSync(
  new URL('../config/env/core.env.example', import.meta.url),
  'utf8',
);
const configurationGuide = readFileSync(
  new URL('../docs/CONFIGURATION.md', import.meta.url),
  'utf8',
);
const daemonEnvironmentExample = readFileSync(
  new URL('../daemon-python/.env.example', import.meta.url),
  'utf8',
);
const daemonConfigSource = readFileSync(
  new URL('../daemon-python/arcanos/config.py', import.meta.url),
  'utf8',
);
const daemonAgentLoopSource = readFileSync(
  new URL('../daemon-python/arcanos/agentic/agent_loop.py', import.meta.url),
  'utf8',
);
const daemonConfigurationSection =
  configurationGuide.match(
    /### Daemon-specific core variables[\s\S]*?(?=\n##\s)/,
  )?.[0] ?? '';
const nonDaemonConfiguration = configurationGuide.replace(
  daemonConfigurationSection,
  '',
);

describe('request timeout configuration ownership', () => {
  it('does not expose an inert Node/backend REQUEST_TIMEOUT contract', () => {
    expect(config.limits).not.toHaveProperty('requestTimeout');
    expect(backendConfigSource).not.toMatch(/requestTimeout\s*:/);
    expect(backendCoreEnvironmentExample).not.toMatch(/^\s*REQUEST_TIMEOUT\s*=/m);
    expect(nonDaemonConfiguration).not.toMatch(
      /^\|\s*`REQUEST_TIMEOUT`\s*\|/m,
    );
  });

  it('preserves the Python daemon seconds-valued REQUEST_TIMEOUT contract', () => {
    expect(daemonEnvironmentExample).toMatch(
      /# Request timeout in seconds \(default: 30\)\r?\nREQUEST_TIMEOUT=30/,
    );
    expect(daemonConfigSource).toContain(
      'REQUEST_TIMEOUT: int = get_env_int("REQUEST_TIMEOUT", 30)',
    );
    expect(daemonConfigSource).toContain(
      'REQUEST_TIMEOUT must be at least 5 seconds',
    );
    expect(daemonAgentLoopSource).toContain('timeout=Config.REQUEST_TIMEOUT');
    expect(daemonConfigurationSection).toMatch(
      /^\|\s*`REQUEST_TIMEOUT`\s*\|\s*`30`\s*\|[^\n]*seconds/mi,
    );
    expect(daemonConfigurationSection).toMatch(
      /^\|\s*`BACKEND_REQUEST_TIMEOUT`\s*\|\s*`15`\s*\|[^\n]*seconds/mi,
    );
  });
});
