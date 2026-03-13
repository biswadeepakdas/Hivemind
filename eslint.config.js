/**
 * ESLint Configuration for Hivemind SESI
 *
 * Enforces code quality standards.
 * Adapted from everything-claude-code's eslint config.
 */

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", ".hivemind/**", "legacy/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "no-undef": "error",
      "eqeqeq": "warn",
      "no-console": "off",
    },
  },
];
