import { defineConfig } from "tsup"

/**
 * The `@lyrashield/cli` alias re-exports the primary `lyrashield` binary.
 * The primary package is a runtime dependency; do not bundle it.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node24",
  tsconfig: "tsconfig.build.json",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
})
