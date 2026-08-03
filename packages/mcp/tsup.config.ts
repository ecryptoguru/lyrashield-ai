import { defineConfig } from "tsup"

/**
 * Bundle the MCP server into a self-contained, publishable package.
 *
 * The workspace dependencies (@lyrashield/types, @lyrashield/logger) are NOT
 * published to npm, so they must be bundled in (`noExternal`). The MCP SDK and
 * zod stay external and are declared as real dependencies in package.json.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "stdio-transport": "src/stdio-transport.ts",
  },
  format: ["esm"],
  target: "node24",
  tsconfig: "tsconfig.build.json",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: [/^@lyrashield\//],
  external: ["@modelcontextprotocol/sdk", "zod"],
  banner: { js: "#!/usr/bin/env node" },
})
