export default [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        exports: "readonly",
        require: "readonly",
        global: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "error",
      "no-unreachable": "error"
    }
  }
];