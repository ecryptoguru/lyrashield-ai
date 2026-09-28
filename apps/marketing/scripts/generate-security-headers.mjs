import { readFileSync, writeFileSync } from "node:fs"

const policy = JSON.parse(
  readFileSync(new URL("../src/lib/marketing-csp.json", import.meta.url), "utf8")
)
const headersUrl = new URL("../public/_headers", import.meta.url)
const headers = readFileSync(headersUrl, "utf8")
const csp = policy.directives.join("; ")
const updated = headers.replace(
  /^  Content-Security-Policy: .*$/m,
  () => `  Content-Security-Policy: ${csp}`
)
if (updated === headers && !headers.includes(`  Content-Security-Policy: ${csp}`)) {
  throw new Error("Missing catch-all Content-Security-Policy in public/_headers")
}
if (updated !== headers) writeFileSync(headersUrl, updated)
