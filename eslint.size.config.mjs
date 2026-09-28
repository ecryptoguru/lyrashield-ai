import nextVitals from "eslint-config-next/core-web-vitals"
import securityPlugin from "eslint-plugin-security"

const tsConfig = nextVitals.find((config) => config.name === "next/typescript")
const nextConfig = nextVitals.find((config) => config.name === "next")

export default [
  {
    ignores: [
      "**/*.test.{ts,tsx,mts,cts}",
      "**/__tests__/**",
      "**/*.d.ts",
      "**/generated/**",
      "packages/agent-registry/src/agents.ts",
      "packages/security/src/standards/registry.ts",
      "packages/config/src/env.ts",
      "packages/types/src/openapi/build.ts",
      "apps/worker/src/engine/engine-output-schema.ts",
      "packages/types/src/index.ts",
    ],
  },
  {
    files: ["apps/**/src/**/*.{ts,tsx,mts,cts}", "packages/**/src/**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tsConfig.languageOptions.parser },
    plugins: { ...nextConfig.plugins, security: securityPlugin },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "max-lines": ["warn", { max: 600, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
]
