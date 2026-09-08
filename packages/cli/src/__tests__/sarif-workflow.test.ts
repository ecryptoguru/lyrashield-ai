/* eslint-disable security/detect-non-literal-fs-filename */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("GitHub SARIF result locations", () => {
  for (const path of ["action.yml", ".github/workflows/lyrashield-scan.yml"]) {
    it(`keeps aggregate and file findings uploadable in ${path}`, () => {
      const source = readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8")
      const helper = source.match(/^( *)add_result\(\) \{\n[\s\S]*?^\1\}/m)?.[0]
      expect(helper).toBeDefined()
      const output = execFileSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
RESULTS_FILE="$(mktemp)"
trap 'rm -f "$RESULTS_FILE" "$RESULTS_FILE.tmp"' EXIT
echo '[]' > "$RESULTS_FILE"
${helper}
add_result aggregate error 'Repository-wide finding' ''
add_result file warning 'File finding' 'src/with "quotes".ts'
cat "$RESULTS_FILE"
`,
        ],
        { encoding: "utf8" }
      )
      const results = JSON.parse(output)
      expect(
        results.map(
          (result: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) =>
            result.locations[0]?.physicalLocation.artifactLocation.uri
        )
      ).toEqual([".", 'src/with "quotes".ts'])
    })
  }
})
