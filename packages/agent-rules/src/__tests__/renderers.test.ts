import { describe, expect, it } from "vitest"
import { listRuleFormats, renderRule } from "../index.js"

describe("rule renderers", () => {
  const formats = listRuleFormats()

  it("knows at least the seven rule formats from PR2", () => {
    const ids = formats.map((f) => f.format)
    expect(ids).toEqual(
      expect.arrayContaining([
        "claude-code",
        "agents-md",
        "cursor",
        "copilot",
        "windsurf",
        "cline",
        "openclaw",
      ])
    )
  })

  for (const info of formats) {
    for (const file of info.defaultFiles) {
      it(`${info.format} (${file}) produces non-empty output`, () => {
        const rule = renderRule({
          format: info.format,
          file,
          agentId: "test-agent",
          agentDisplayName: info.label,
        })
        expect(rule.inner.length).toBeGreaterThan(0)
        expect(rule.content.length).toBeGreaterThan(rule.inner.length)
        expect(rule.content).toContain("lyrashield:begin")
        expect(rule.content).toContain("lyrashield:end")
        expect(rule.sha).toMatch(/^[0-9a-f]{12}$/)
      })

      it(`${info.format} (${file}) includes the honesty clause`, () => {
        const rule = renderRule({
          format: info.format,
          file,
          agentId: "test-agent",
          agentDisplayName: info.label,
        })
        expect(rule.inner).toMatch(/clean check result does not guarantee/i)
        expect(rule.inner).toMatch(/passing check is not a guarantee/i)
      })
    }
  }

  it("cursor mdc includes globs and frontmatter", () => {
    const mdc = renderRule({
      format: "cursor",
      file: ".cursor/rules/lyrashield.mdc",
      agentId: "cursor",
    })
    expect(mdc.inner).toContain("---")
    expect(mdc.inner).toContain("globs:")
    expect(mdc.inner).toContain("alwaysApply:")
  })

  it("openclaw skill.md includes skill metadata", () => {
    const skill = renderRule({
      format: "openclaw",
      file: "skills/lyrashield/skill.md",
      agentId: "openclaw",
    })
    expect(skill.inner).toContain("name: lyra-shield-security")
    expect(skill.inner).toContain("description:")
  })

  it("windsurf workflow includes ordered workflow steps", () => {
    const rule = renderRule({
      format: "windsurf",
      file: ".windsurf/rules/lyrashield.md",
      agentId: "windsurf",
    })
    expect(rule.inner).toContain("## Workflow")
    expect(rule.inner).toMatch(/1\..*check-diff/)
    expect(rule.inner).toMatch(/3\..*verify-fix/)
  })
})
