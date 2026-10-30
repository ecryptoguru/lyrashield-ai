import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ESLint } from "eslint"
import { collectSizeDebt, findSizeRegressions, findStaleSizeBaseline } from "./size-ratchet.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const requireAstro = createRequire(
  realpathSync(path.join(root, "apps/marketing/node_modules/astro/package.json"))
)
const { parse } = requireAstro("@astrojs/compiler")

export async function astroCodeBlocks(source) {
  const { ast, diagnostics = [] } = await parse(source)
  if (diagnostics.some((diagnostic) => diagnostic.severity === 1))
    throw new Error("Astro parsing failed")
  const blocks = []
  function visit(node) {
    if (node.type === "frontmatter") blocks.push(node.value)
    if (node.type === "element" && node.name === "script") {
      // JSON/JSON-LD is data, never JavaScript. External scripts have no body.
      const type = node.attributes.find((attribute) => attribute.name === "type")?.value
      if (!type || ["module", "text/javascript", "application/javascript"].includes(type))
        blocks.push(node.children.map((child) => child.value ?? "").join(""))
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(ast)
  return blocks.filter((block) => block.trim())
}

export async function measureSurfaceFile(eslint, file, source) {
  if (!file.endsWith(".astro")) return eslint.lintText(source, { filePath: file })
  const blocks = await astroCodeBlocks(source)
  const results = []
  for (const block of blocks) {
    const [result] = await eslint.lintText(block, { filePath: "apps/marketing/src/size-block.ts" })
    // Measure the Astro file once, and JavaScript functions through the TS parser.
    results.push({
      ...result,
      filePath: path.join(root, file),
      messages: result.messages.filter((message) => message.ruleId !== "max-lines"),
    })
  }
  const lines = source.split(/\r?\n/).filter((line) => line.trim()).length
  if (lines > 600)
    results.push({
      filePath: path.join(root, file),
      errorCount: 0,
      messages: [
        {
          ruleId: "max-lines",
          line: 1,
          message: `File has too many lines (${lines}). Maximum allowed is 600.`,
        },
      ],
    })
  return results
}

async function run() {
  process.chdir(root)
  const eslint = new ESLint({ overrideConfigFile: "eslint.size.config.mjs" })
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(
      (file) =>
        (/^(apps|packages)\//.test(file) && file.endsWith(".astro")) ||
        (/^(apps|packages|lint|ops|\.github\/scripts)\//.test(file) &&
          file.endsWith(".mjs") &&
          !file.endsWith(".test.mjs"))
    )
  const results = []
  for (const file of files)
    results.push(...(await measureSurfaceFile(eslint, file, await readFile(file, "utf8"))))
  const { metrics, errors } = collectSizeDebt(results)
  if (errors.length) throw new Error(errors.join("\n"))
  const baselinePath = path.join(root, "lint/surface-size-baseline.json")
  let previous
  try {
    previous = JSON.parse(await readFile(baselinePath, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (process.argv.includes("--initialize") && !previous) {
    await writeFile(
      baselinePath,
      JSON.stringify(
        {
          version: 1,
          limits: { "max-lines": 600, "max-lines-per-function": 150 },
          metrics: Object.fromEntries(Object.entries(metrics).sort()),
        },
        null,
        2
      ) + "\n"
    )
    return
  }
  if (
    !previous ||
    previous.version !== 1 ||
    JSON.stringify(previous.limits) !==
      JSON.stringify({ "max-lines": 600, "max-lines-per-function": 150 })
  )
    throw new Error("Missing or unsupported surface-size baseline")
  const issues = findSizeRegressions(previous.metrics, metrics)
  if (issues.length) throw new Error(issues.join("\n"))
  if (process.argv.includes("--write-baseline")) {
    await writeFile(
      baselinePath,
      JSON.stringify(
        { ...previous, metrics: Object.fromEntries(Object.entries(metrics).sort()) },
        null,
        2
      ) + "\n"
    )
  } else {
    const stale = findStaleSizeBaseline(previous.metrics, metrics)
    if (stale.length) throw new Error(stale.join("\n"))
  }
  console.log(`Astro/MJS size ratchet passed for ${files.length} files.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
