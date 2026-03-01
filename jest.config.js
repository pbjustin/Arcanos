export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.[tj]s'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', {
      useESM: true,
      transpilation: true,
      tsconfig: { allowJs: true }
    }]
  },
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
    '^@routes/(.*)\\.js$': '<rootDir>/src/routes/$1',
    '^@routes/(.*)$': '<rootDir>/src/routes/$1',
    '^@arcanos/openai$': '<rootDir>/packages/arcanos-openai/src/index.ts',
    '^@arcanos/openai/(.*)$': '<rootDir>/packages/arcanos-openai/src/$1.ts',
    '^@arcanos/runtime$': '<rootDir>/packages/arcanos-runtime/src/index.ts',
    '^@arcanos/runtime/(.*)$': '<rootDir>/packages/arcanos-runtime/src/$1.ts'
  },
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text-summary'],
  collectCoverageFrom: [
    'src/**/*.ts',
    'workers/src/**/*.ts',
    '!src/**/*.d.ts',
    '!**/node_modules/**'
  ]
};
