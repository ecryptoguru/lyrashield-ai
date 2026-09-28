import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../dist/client/", import.meta.url))
const policy = JSON.parse(
  readFileSync(new URL("../src/lib/marketing-csp.json", import.meta.url), "utf8")
)
const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
const csp = policy.directives.join("; ")
if (!headers.includes(`  Content-Security-Policy: ${csp}\n`)) {
  throw new Error("Static CSP differs from the Worker policy; regenerate public/_headers")
}
const scriptDirective = policy.directives.find((directive) => directive.startsWith("script-src "))
if (!scriptDirective || scriptDirective.includes("'unsafe-inline'")) {
  throw new Error("Marketing script-src must exclude unsafe-inline")
}

let checked = 0
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      inspect(path)
    } else if (entry.name.endsWith(".html")) {
      checked++
      const html = readFileSync(path, "utf8")
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const [, attributes, body] = match
        if (
          /\bsrc\s*=/.test(attributes) ||
          /\btype\s*=\s*["']application\/ld\+json["']/i.test(attributes)
        ) {
          continue
        }
        if (body.trim()) throw new Error(`Executable inline script in ${path}`)
      }
      if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) {
        throw new Error(`Inline event handler in ${path}`)
      }
    }
  }
}

inspect(root)
if (checked === 0) throw new Error("No prerendered HTML was checked")
console.log(`CSP validation passed for ${checked} prerendered HTML files`)
