import { readFileSync } from "node:fs"

// stdout is an untrusted guest transcript. Keep its bytes and the expected
// invocation challenge out of parser diagnostics, including assertion diffs.
let diagnostic = "unverified response"
function verified() {
  const [owner, digest] = process.argv.slice(2)
  const nonce = readFileSync(3, "utf8").trimEnd()
  if (!/^[a-f0-9]{64}$/.test(nonce)) return false
  const { value } = JSON.parse(readFileSync(0, "utf8"))
  if (!Array.isArray(value) || !value.length || value.length > 2) return false
  if (!value.every((row) => typeof row.message === "string" && row.message.length <= 8192))
    return false
  // This allowlisted frame is diagnostic only. Its challenge and the guest
  // transcript never enter recovery output, even on failed extension status.
  for (const row of value) {
    for (const line of row.message.split(/\r?\n/)) {
      const match =
        /^PAIRED_VM_FAILED ([a-f0-9]{64}) (prepare|drain|promote|cleanup) ([1-9][0-9]{0,2})$/.exec(
          line
        )
      if (match && match[1] === nonce && Number(match[3]) <= 255) {
        diagnostic = "guest stage " + match[2] + ", exit " + match[3]
        return false
      }
    }
  }
  if (!value.every((row) => /^ComponentStatus\/Std(Out|Err)\/succeeded$/i.test(row.code))) {
    diagnostic = "extension status unsuccessful"
    return false
  }
  const stdout = value.filter((row) => /^ComponentStatus\/StdOut\//i.test(row.code))
  if (stdout.length !== 1) return false
  // systemd enable and Docker routinely emit successful progress on stderr.
  // Only supervisor stdout can complete the challenge. Ignore all stderr text.
  const [body] = stdout[0].message.split(/(?:^|\n)\[stderr\]\r?(?:\n|$)/, 1)
  const lines = body.trimEnd().split(/\r?\n/)
  return (
    lines.at(-2) === `Worker paired release promotion passed for ${digest}; scan admission HELD` &&
    lines.at(-1) === `PAIRED_VM_COMPLETED ${owner} ${digest} ${nonce}`
  )
}

try {
  if (!verified()) throw new Error()
  console.log("Paired VM held promotion verified")
} catch {
  console.error("Paired VM completion unverified (" + diagnostic + ")")
  process.exitCode = 1
}
