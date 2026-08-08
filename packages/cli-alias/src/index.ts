import process from "node:process"

const args = process.argv.slice(2)
const isVersion = args.includes("--version") || args.includes("-v")
const isHelp = args.includes("--help") || args.includes("-h") || args.length === 0

if (!isVersion && !isHelp) {
  process.emitWarning(
    "@lyrashield/cli is deprecated. Use the unscoped `lyrashield` package instead (`npx lyrashield ...`). This alias will be removed in the next major release.",
    "DeprecationWarning"
  )
}

await import("lyrashield")
