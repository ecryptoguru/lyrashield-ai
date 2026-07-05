import nextVitals from "eslint-config-next/core-web-vitals"
import securityPlugin from "eslint-plugin-security"

const eslintConfig = [
  ...nextVitals,
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
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
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
]

export default eslintConfig
