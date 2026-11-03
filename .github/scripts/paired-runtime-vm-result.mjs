import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
const [owner, digest] = process.argv.slice(2)
const { value } = JSON.parse(readFileSync(0, "utf8"))
// Raw Azure VM RunCommandResult has distinct status entries for guest stdout
// and stderr. Never accept a marker copied into a failed operation diagnostic.
assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 2)
assert.ok(value.every((row) => /^ComponentStatus\/Std(Out|Err)\/succeeded$/i.test(row.code)))
const stdout = value.filter((row) => /^ComponentStatus\/StdOut\/succeeded$/i.test(row.code))
assert.equal(stdout.length, 1)
const message = stdout[0].message
assert.ok(typeof message === "string" && message.length <= 8192)
const beforeStderr = message.split(/(?:^|\n)\[stderr\]\r?(?:\n|$)/)
assert.ok(beforeStderr.length <= 2)
const lines = beforeStderr[0].trimEnd().split(/\r?\n/)
assert.deepEqual(lines.slice(-2), [
  `Worker paired release promotion passed for ${digest}; scan admission HELD`,
  `PAIRED_VM_COMPLETED ${owner} ${digest}`,
])
console.log("Paired VM held promotion verified")
