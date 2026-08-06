import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node24",
  tsconfig: "tsconfig.build.json",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: [/^@lyrashield\//],
})
