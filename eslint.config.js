import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022
      }
    },
    rules: {
      "no-unused-vars": "warn", // Warn instead of error for legacy files
      "no-unreachable": "error"
    }
  },
  {
    ignores: [
      "dist/**", 
      "node_modules/**", 
      "**/*.d.ts",
      "src/**/*.ts", // Skip TypeScript files - handled by tsc
      "scripts/**/*.ts", // Skip TypeScript files in scripts
      "tests/**/*.ts" // Skip TypeScript test files
    ]
  }
];