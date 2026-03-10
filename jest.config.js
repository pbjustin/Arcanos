import { codecovCoverageScopeFiles } from './config/coverageScope.js';

//audit assumption: the root Jest project owns only repository and worker suites while the AI runtime package runs its own node:test entrypoints.
//audit failure risk: discovering mirrored workspaces or the nested runtime package causes duplicate execution or unsupported runner failures in CI.
//audit expected invariant: root Jest indexes only the active root workspace tests and ignores nested runner-owned paths.
//audit handling strategy: exclude mirrored workspaces and the AI runtime test package from discovery, module indexing, and watch mode.
const ignoredRootJestPatterns = [
  '<rootDir>/\\.codex-pr-.*',
  '<rootDir>/\\.deploy-pr-.*',
  '<rootDir>/tmp/phase7-ref/.*',
  '<rootDir>/arcanos-ai-runtime/tests/.*'
];

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.[tj]s'],
  testPathIgnorePatterns: [
    ...ignoredRootJestPatterns,
    '[\\\\/]node_modules[\\\\/]',
    '[\\\\/]dist[\\\\/]',
    '[\\\\/]coverage[\\\\/]'
  ],
  modulePathIgnorePatterns: ignoredRootJestPatterns,
  watchPathIgnorePatterns: ignoredRootJestPatterns,
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', {
      useESM: true,
      transpilation: true,
      tsconfig: { allowJs: true }
    }]
  },
  //audit assumption: repository tests should not inherit stale spies or mock call counts across files; failure risk: intermittent assertions depend on prior suite state; expected invariant: each test starts with cleared/restored Jest mocks unless a suite opts into custom reset behavior; handling strategy: enable Jest's built-in mock hygiene globally.
  clearMocks: true,
  restoreMocks: true,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@core/lib/(.*)\\.js$': '<rootDir>/src/lib/$1',
    '^@core/lib/(.*)$': '<rootDir>/src/lib/$1',
    '^@platform/(.*)\\.js$': '<rootDir>/src/platform/$1',
    '^@platform$': '<rootDir>/src/platform/index.ts',
    '^@platform/(.*)$': '<rootDir>/src/platform/$1',
    '^@services/(.*)\\.js$': '<rootDir>/src/services/$1',
    '^@services/(.*)$': '<rootDir>/src/services/$1',
    '^@shared/(.*)\\.js$': '<rootDir>/src/shared/$1',
    '^@shared$': '<rootDir>/src/shared/index.ts',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@transport/(.*)\\.js$': '<rootDir>/src/transport/$1',
    '^@transport$': '<rootDir>/src/transport/index.ts',
    '^@transport/(.*)$': '<rootDir>/src/transport/$1',
    '^@core/(.*)\\.js$': '<rootDir>/src/core/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@analytics/(.*)\\.js$': '<rootDir>/src/analytics/$1',
    '^@analytics/(.*)$': '<rootDir>/src/analytics/$1',
    '^@config/(.*)\\.js$': '<rootDir>/src/config/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@stores/(.*)\\.js$': '<rootDir>/src/stores/$1',
    '^@stores/(.*)$': '<rootDir>/src/stores/$1',
    '^@dispatcher/(.*)\\.js$': '<rootDir>/src/dispatcher/$1',
    '^@dispatcher/(.*)$': '<rootDir>/src/dispatcher/$1',
    '^@trinity/(.*)\\.js$': '<rootDir>/src/trinity/$1',
    '^@trinity/(.*)$': '<rootDir>/src/trinity/$1',
    '^@middleware/(.*)\\.js$': '<rootDir>/src/middleware/$1',
    '^@middleware/(.*)$': '<rootDir>/src/middleware/$1',
    '^@routes/(.*)\\.js$': '<rootDir>/src/routes/$1',
    '^@routes/(.*)$': '<rootDir>/src/routes/$1',
    '^@dag/(.*)\\.js$': '<rootDir>/src/dag/$1',
    '^@dag/(.*)$': '<rootDir>/src/dag/$1',
    '^@workers/(.*)\\.js$': '<rootDir>/src/workers/$1',
    '^@workers/(.*)$': '<rootDir>/src/workers/$1',
    '^@arcanos/openai$': '<rootDir>/packages/arcanos-openai/src/index.ts',
    '^@arcanos/openai/(.*)$': '<rootDir>/packages/arcanos-openai/src/$1.ts',
    '^@arcanos/runtime$': '<rootDir>/packages/arcanos-runtime/src/index.ts',
    '^@arcanos/runtime/(.*)$': '<rootDir>/packages/arcanos-runtime/src/$1.ts',
    '^@prisma/client$': '<rootDir>/tests/mocks/prisma-client.ts',
    '^@prisma/client/(.*)$': '<rootDir>/tests/mocks/prisma-client.ts'
  },
  collectCoverage: true,
  coverageProvider: 'v8',
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text-summary'],
  //audit assumption: reported project coverage should track only the explicitly coverage-owned repository slice; failure risk: incidental imports drag in partially tested files and dilute the Codecov project signal; expected invariant: coverage is collected only for the curated opt-in file list; handling strategy: bind collectCoverageFrom to a static scope module reviewed in-repo.
  collectCoverageFrom: codecovCoverageScopeFiles,
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  }
};
