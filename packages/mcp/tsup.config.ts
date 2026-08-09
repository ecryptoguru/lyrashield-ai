import { defineConfig } from "tsup"

/**
 * Bundle the MCP server into a self-contained, publishable package.
 *
 * All workspace dependencies are private and bundled in (`noExternal`). The
 * public MCP SDK and zod stay external and are declared in package.json.
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
