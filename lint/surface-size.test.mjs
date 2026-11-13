import { expect, it } from "vitest"
import { ESLint } from "eslint"
import { astroCodeBlocks, measureSurfaceFile } from "./surface-size.mjs"
const eslint = new ESLint({ overrideConfigFile: "eslint.size.config.mjs" })
it("parses Astro frontmatter and executable script bodies without treating markup or JSON-LD as JavaScript", async () => {
  const source =
    '---\nconst heading: string = "Hello"\n---\n<div>{heading}</div><script type="application/ld+json">{"@type":"WebPage"}</script><script>const client = 1</script>'
  expect(await astroCodeBlocks(source)).toHaveLength(2)
  const results = await measureSurfaceFile(eslint, "apps/marketing/src/page.astro", source)
  expect(results.every((result) => result.errorCount === 0)).toBe(true)
})
it("measures MJS functions and Astro template file growth", async () => {
  const source = `function large() {\n${'  console.log("line")\n'.repeat(160)}}\n`
  const results = await measureSurfaceFile(eslint, ".github/scripts/size-fixture.mjs", source)
  expect(
    results
      .flatMap((result) => result.messages)
      .some((message) => message.ruleId === "max-lines-per-function")
  ).toBe(true)
  const template = await measureSurfaceFile(
    eslint,
    "apps/marketing/src/page.astro",
    "<div>line</div>\n".repeat(601)
  )
  expect(
    template.flatMap((result) => result.messages).some((message) => message.ruleId === "max-lines")
  ).toBe(true)
})
