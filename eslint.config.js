import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';

const rootSourceFiles = [
  'src/**/*.{ts,js}'
];

const workspaceSourceFiles = [
  'packages/*/src/**/*.{ts,js}',
  'workers/src/**/*.{ts,js}',
  'arcanos-ai-runtime/src/**/*.{ts,js}'
];

const testFiles = [
  'tests/**/*.{ts,js}',
  'packages/*/__tests__/**/*.{ts,js}',
  'arcanos-ai-runtime/tests/**/*.{ts,js}'
];

const ignoredFiles = [
  '**/dist/**',
  '**/*.d.ts',
  '**/node_modules/**',
  'validate-refactoring.js',
  '.codex-pr-*/**',
  '.deploy-pr-*/**'
];

const sharedRestrictedImportPatterns = [
  { group: ['../legacy/**', '../../legacy/**', '../../../legacy/**', 'legacy/**'], message: 'Legacy code is read-only; do not import it from production modules.' },
  { group: ['../cli/**', '../cli_v2/**', '../agent_core/**', 'cli/**', 'cli_v2/**', 'agent_core/**'], message: 'CLI/agent_core are legacy; import from legacy/ only if you are working inside legacy.' }
];

const sharedLanguageOptions = {
  parser: tsParser,
  ecmaVersion: 2022,
  sourceType: 'module',
  globals: {
    console: 'readonly',
    process: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    module: 'readonly',
    exports: 'readonly',
    require: 'readonly',
    global: 'readonly',
    Buffer: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly'
  }
};

export default [
  {
    ignores: ignoredFiles
  },
  {
    files: ['src/routes/_core/gptDispatch.ts', 'src/workers/jobRunner.ts'],
    languageOptions: sharedLanguageOptions,
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import': importPlugin
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '@services/arcanosMcp',
              '@services/arcanosMcp.js',
              '@services/runtimeInspectionRoutingService',
              '@services/runtimeInspectionRoutingService.js',
              '@routes/ask/dagTools',
              '@routes/ask/dagTools.js',
              '@services/systemState',
              '@services/systemState.js'
            ],
            message: 'Write-plane modules must not import control-plane execution modules.'
          }
        ]
      }]
    }
  },
  {
    files: ['src/services/runtimeInspectionRoutingService.ts', 'src/services/systemState.ts', 'src/routes/ask/dagTools.ts', 'src/mcp/server/**/*.ts'],
    languageOptions: sharedLanguageOptions,
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import': importPlugin
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@routes/_core/gptDispatch', '@routes/_core/gptDispatch.js'],
            message: 'Control-plane modules must not import the writing dispatcher.'
          }
        ]
      }]
    }
  },
  {
    files: ['src/shared/**/*.{ts,js}'],
    languageOptions: sharedLanguageOptions,
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import': importPlugin
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@routes/**', '../routes/**', '../../routes/**', '../../../routes/**'],
            message: 'Shared modules must remain routing-agnostic.'
          }
        ]
      }]
    }
  },
  {
    files: rootSourceFiles,
    ignores: ['**/*.test.*'],
    languageOptions: sharedLanguageOptions,
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import': importPlugin
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          ...sharedRestrictedImportPatterns,
          { group: ['../../*', '../../../*'], message: 'Avoid deep relative imports that bypass local module boundaries.' }
        ]
      }],
      'no-unreachable': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'destructuredArrayIgnorePattern': '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'import/no-cycle': 'error'
    }
  },
  {
    files: workspaceSourceFiles,
    ignores: ['**/*.test.*'],
    languageOptions: sharedLanguageOptions,
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import': importPlugin
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: sharedRestrictedImportPatterns
      }],
      'no-unreachable': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'destructuredArrayIgnorePattern': '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'import/no-cycle': 'error'
    }
  },

  {
    files: testFiles,
    languageOptions: {
      ...sharedLanguageOptions,
      ecmaVersion: 'latest'
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import': importPlugin
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'destructuredArrayIgnorePattern': '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
