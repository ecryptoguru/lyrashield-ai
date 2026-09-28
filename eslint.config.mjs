import nextVitals from "eslint-config-next/core-web-vitals"
import securityPlugin from "eslint-plugin-security"
import typeAssertionRatchet from "./lint/type-assertion-ratchet.mjs"

const eslintConfig = [
  ...nextVitals,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/packages/db/src/generated/**",
    ],
  },
  {
    settings: {
      react: {
        version: "19.0",
      },
    },
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "allow-as-parameter" },
      ],
    },
  },
  {
    files: ["apps/**/src/**/*.{ts,tsx,mts,cts}", "packages/**/src/**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/*.test.{ts,tsx,mts,cts}", "**/__tests__/**"],
    plugins: { "type-assertion-ratchet": typeAssertionRatchet },
    rules: {
      "type-assertion-ratchet/no-new-unsafe-assertion": "error",
    },
  },
  {
    plugins: { security: securityPlugin },
    rules: {
      "security/detect-object-injection": "off",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-unsafe-regex": "warn",
      "security/detect-buffer-noassert": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-new-buffer": "warn",
    },
  },
  {
    files: ["**/*.test.{ts,tsx,mts}", "**/__tests__/**"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
]

export default eslintConfig
