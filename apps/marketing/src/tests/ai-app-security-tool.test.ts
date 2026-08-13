import { describe, expect, it } from "vitest"
import { tools } from "../lib/tools"
import {
  AI_APP_SECURITY_FREE_CONTROLS,
  buildSummary,
  pastedCodeForScan,
  readFilesForScan,
  runAiAppSecurityScan,
  toUiSignals,
} from "../lib/ai-app-security"

function fileFromText(name: string, content: string, type = "text/plain"): File {
  return new File([content], name, { type })
}

const VULNERABLE_PROMPT = `
import OpenAI from "openai"
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function ask(userInput: string) {
  return openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: userInput }],
  })
}
`

describe("AI App Security scanner marketing tool", () => {
  it("is registered in the tools catalog", () => {
    const tool = tools.find((t) => t.slug === "ai-app-security-scanner")
    expect(tool).toBeDefined()
    expect(tool?.title).toBe("AI App Security Scanner")
    expect(tool?.checks).toHaveLength(3)
    expect(tool?.limitations).toHaveLength(3)
    expect(tool?.references.length).toBeGreaterThan(0)
    expect(tool?.privacy).toContain("never leave your device")
  })

  it("runs a browser-local scan against pasted vulnerable TypeScript", () => {
    const file = pastedCodeForScan(VULNERABLE_PROMPT, ".ts")
    const result = runAiAppSecurityScan([file])
    const summary = buildSummary(result)

    expect(summary.total).toBe(8)
    expect(summary.controls.some((c) => c.id === "AI-01" && c.state === "DETECTED")).toBe(true)
    expect(summary.controls.some((c) => c.id === "AI-03" && c.state === "NOT_ASSESSED")).toBe(true)
  })

  it("produces a DETECTED signal for prompt injection with line evidence", () => {
    const file = pastedCodeForScan(VULNERABLE_PROMPT, ".ts")
    const result = runAiAppSecurityScan([file])
    const signals = toUiSignals(result)
    const promptInjection = signals.find((s) => s.controlId === "AI-01")

    expect(promptInjection).toBeDefined()
    expect(promptInjection?.state).toBe("DETECTED")
    expect(promptInjection?.line).toBeGreaterThan(0)
    expect(promptInjection?.remediation).toBeTruthy()
  })

  it("excludes AI-03 from the free local scan", () => {
    expect(AI_APP_SECURITY_FREE_CONTROLS).not.toContain("AI-03")

    const file = pastedCodeForScan(VULNERABLE_PROMPT, ".ts")
    const result = runAiAppSecurityScan([file])
    const summary = buildSummary(result)

    const ai03 = summary.controls.find((c) => c.id === "AI-03")
    expect(ai03?.state).toBe("NOT_ASSESSED")
    expect(result.signals.some((s) => s.controlId === "AI-03" && s.state !== "NOT_ASSESSED")).toBe(
      false
    )
  })

  it("reads selected files into the scan contract without transformation", async () => {
    const files = [fileFromText("route.ts", VULNERABLE_PROMPT)]
    const scanFiles = await readFilesForScan(files)

    expect(scanFiles).toHaveLength(1)
    expect(scanFiles[0]?.path).toBe("route.ts")
    expect(scanFiles[0]?.content).toContain("chat.completions.create")
    expect(scanFiles[0]?.language).toBe("typescript")
  })
})
