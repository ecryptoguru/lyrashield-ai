import { describe, expect, it } from "vitest"
import { scanAiDataExposure } from "./ai-data-exposure"

describe("scanAiDataExposure", () => {
  it("detects raw prompt logging without treating an SDK import as exfiltration", () => {
    expect(
      scanAiDataExposure({
        path: "chat.ts",
        content: "logger.info({ prompt: request.messages })",
      })
    ).toContainEqual(expect.objectContaining({ controlIds: [33, 40], severity: "HIGH" }))
    expect(
      scanAiDataExposure({ path: "client.ts", content: "import OpenAI from 'openai'" })
    ).toEqual([])
    expect(
      scanAiDataExposure({
        path: "get_console_errors.ts",
        content: 'console.log("Could not read response text")',
      })
    ).toEqual([])
    expect(
      scanAiDataExposure({ path: "chat.ts", content: 'console.log(prompt + " suffix")' })
    ).toContainEqual(expect.objectContaining({ title: "Raw AI prompt or response logged" }))
  })

  it("flags direct wildcard MCP permissions and command execution without approval", () => {
    const findings = scanAiDataExposure({
      path: "mcp.json",
      content: [
        '{ "capabilities": ["write-all"] }',
        'const tool = { command: "rm -rf cache", execute: true }',
      ].join("\n"),
    })

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ controlIds: [42] }),
        expect.objectContaining({ controlIds: [44] }),
      ])
    )
  })

  it("does not turn documentation, dependency names or UI shells into command findings", () => {
    for (const [path, content] of [
      ["docs/runbook.md", "| Task | Command |"],
      ["package-lock.json", '"node_modules/shell-quote": {'],
      ["app/dashboard/layout.tsx", "const shell = <Sidebar />"],
      ["tests/e2e/error-boundary.spec.ts", 'test("Dashboard shell renders", () => {})'],
    ]) {
      expect(scanAiDataExposure({ path, content })).toEqual([])
    }
  })

  it("does not borrow an execution flag from a separate object", () => {
    expect(
      scanAiDataExposure({
        path: "tools.ts",
        content: 'const tool = { command: "ls" }; const options = { execute: true }',
      })
    ).toEqual([])
  })

  it("flags declared RAG ingestion with no access-control field", () => {
    expect(
      scanAiDataExposure({
        path: "ingest.ts",
        content: "await vectorStore.addDocuments(documents)",
      })
    ).toContainEqual(expect.objectContaining({ controlIds: [40] }))
  })

  it("flags an explicitly empty tool input schema", () => {
    expect(
      scanAiDataExposure({ path: "tools.ts", content: "const tool = { inputSchema: {} }" })
    ).toContainEqual(expect.objectContaining({ controlIds: [42], severity: "MEDIUM" }))
  })
})
