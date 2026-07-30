import { defineConfig } from "tsup"

/**
 * Bundle the LyraShield CLI into a self-contained, publishable binary.
 *
 * Workspace dependencies (@lyrashield/agent-registry, @lyrashield/sdk) are not
 * published, so they are bundled in (`noExternal`). Runtime dependencies stay
 * external and are declared in package.json.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  tsconfig: "tsconfig.build.json",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: [/^@lyrashield\//],
  external: ["jsonc-parser", "yaml", "@iarna/toml", "minimist"],
  banner: { js: "#!/usr/bin/env node" },
})
