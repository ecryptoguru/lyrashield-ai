// Check every branch of the privileged adapters, including disabled branches.
export default [
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: Object.fromEntries(
        [
          "process",
          "Buffer",
          "URL",
          "console",
          "performance",
          "setTimeout",
          "clearTimeout",
          "fetch",
          "structuredClone",
          "globalThis",
        ].map((name) => [name, "readonly"])
      ),
    },
    rules: { "no-undef": "error" },
  },
]
