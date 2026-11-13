import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const marketingRequire = createRequire(
  new URL("../../../apps/marketing/package.json", import.meta.url)
)
const typographyUtils = marketingRequire(
  join(dirname(marketingRequire.resolve("@tailwindcss/typography")), "utils.js")
)
const cliRequire = createRequire(require.resolve("markdownlint-cli2"))
const markdownRequire = createRequire(cliRequire.resolve("markdownlint"))
const { lint } = await import(cliRequire.resolve("markdownlint/sync"))

test("typography preserves shared trailing pseudos and distinct selector branches", () => {
  assert.deepEqual(typographyUtils.commonTrailingPseudos("a::before, b::before"), [
    "::before",
    "a, b",
  ])
  assert.deepEqual(typographyUtils.commonTrailingPseudos("a::before, b::after"), [
    null,
    "a::before, b::after",
  ])
  assert.deepEqual(typographyUtils.commonTrailingPseudos(":is(a, b)::before::marker"), [
    "::before::marker",
    ":is(a, b)",
  ])
  assert.throws(() => typographyUtils.commonTrailingPseudos("a["))
})

test("markdownlint parses inline and display math while retaining heading diagnostics", () => {
  const math = "Inline $a^2 + b^2 = c^2$.\n\n$$\n\\frac{1}{2}\n$$\n"
  const config = { default: false, MD001: true }
  assert.deepEqual(lint({ strings: { fixture: `# Math\n\n${math}` }, config }).fixture, [])
  const invalid = lint({ strings: { fixture: `# Math\n\n${math}\n### Skipped level\n` }, config })
  assert.deepEqual(
    invalid.fixture.map((error) => error.ruleNames[0]),
    ["MD001"]
  )
})

test("the math extension renders ordinary math without inheriting a polluted trust setting", () => {
  // Isolate Object.prototype pollution from the Node test runner and other tests.
  const script = `
    import assert from "node:assert/strict";
    import { micromark } from ${JSON.stringify(markdownRequire.resolve("micromark"))};
    import { math, mathHtml } from ${JSON.stringify(markdownRequire.resolve("micromark-extension-math"))};
    const render = (source) => micromark(source, { extensions: [math()], htmlExtensions: [mathHtml()] });
    assert.match(render("$x^2$"), /<math/);
    assert.match(render("$$\\n\\\\frac{1}{2}\\n$$"), /display="block"/);
    Object.defineProperty(Object.prototype, "trust", { value: true, writable: true, configurable: true });
    try {
      const output = render("$\\\\href{https://example.test/}{unsafe}$");
      assert.equal(output.includes('href="https://example.test/'), false);
    } finally {
      delete Object.prototype.trust;
    }
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
