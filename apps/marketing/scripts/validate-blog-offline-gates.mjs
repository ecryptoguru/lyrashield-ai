#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { DEAD_URLS, findDeadUrls, findUnquotedColonScalars } from "./blog-offline-gates.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const roots = [resolve(here, "../src/content/blog"), resolve(here, "../src/content/compare")]

function main() {
  const errors = []
  let checked = 0

  for (const root of roots) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned content directories.
    for (const name of readdirSync(root).filter((file) => /\.mdx?$/.test(file))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Descendant of the directory listed above.
      const raw = readFileSync(join(root, name), "utf8")
      checked += 1

      const closing = raw.indexOf("\n---\n", 4)
      if (raw.startsWith("---") && closing !== -1) {
        for (const offender of findUnquotedColonScalars(raw.slice(4, closing))) {
          errors.push(
            `${name}:${offender.line + 1}: frontmatter "${offender.key}" is unquoted and contains ": ", which YAML reads as a nested mapping`
          )
        }
      }

      for (const dead of findDeadUrls(raw)) {
        errors.push(`${name}: known-dead URL ${dead} -- use ${DEAD_URLS[dead]}`)
      }
    }
  }

  if (errors.length > 0) {
    console.error(`Blog offline gate failed (${errors.length} violations):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exit(1)
  }

  console.log(`Blog offline gate passed for ${checked} files.`)
}

main()
