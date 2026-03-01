import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    files: ['src/**/*.{ts,js}'],
    ignores: ['tests/**', '**/*.test.*', 'validate-refactoring.js', 'dist/**', 'node_modules/**'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        createDefaultProgram: true
      },
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
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import': importPlugin
    },
    rules: {
      
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['../legacy/**', '../../legacy/**', '../../../legacy/**', 'legacy/**'], message: 'Legacy code is read-only; do not import it from production modules.' },
          { group: ['../cli/**','../cli_v2/**','../agent_core/**','cli/**','cli_v2/**','agent_core/**'], message: 'CLI/agent_core are legacy; import from legacy/ only if you are working inside legacy.' }
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
      'import/no-cycle': 'error',
      'no-restricted-imports': [
        'error',
        {
          'patterns': ['../../*', '../../../*']
        }
      ]
    }
  }
];
