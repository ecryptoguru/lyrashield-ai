import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/scans",
}))

vi.mock("./use-myra-panel", () => ({
  useMyraPanel: () => ({
    turns: [],
    input: "draft text",
    streaming: true,
    activity: null,
    announcement: "",
    suggestions: [],
    suggestActive: -1,
    caseForm: null,
    logRef: { current: null },
    inputRef: { current: null },
    setCaseForm: vi.fn(),
    send: vi.fn(),
    stopStream: vi.fn(),
    onInputChange: vi.fn(),
    onInputKeyDown: vi.fn(),
    pickSuggestion: vi.fn(),
    submitCaseForm: vi.fn(),
    componentContext: {
      onPickSlot: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onForgetMemory: vi.fn(),
      proposalStates: {},
    },
  }),
}))

import { MyraPanel } from "./myra-panel"

// The Enter-to-send guard lives in the useMyraPanel hook, which cannot be
// driven to a streaming state without a DOM. Pin it at the source here.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const hookSource = readFileSync(new URL("./use-myra-panel.ts", import.meta.url), "utf8")

describe("MyraPanel while Myra is answering", () => {
  const html = renderToStaticMarkup(<MyraPanel />)

  it("disables the Send button while streaming", () => {
    const sendButton = /<button[^>]*>(?:(?!<button)[\s\S])*?Send<\/button>/.exec(html)?.[0]
    expect(sendButton).toBeDefined()
    // `disabled:` also appears inside the shared button class list — assert the
    // attribute itself, not the utility classes.
    expect(sendButton).toContain('disabled=""')
  })

  it("shows a visible Myra is answering hint next to the composer", () => {
    expect(html).toContain("Myra is answering")
  })

  it("keeps the polite live-region announcement element", () => {
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })

  it("blocks Enter-to-send while a stream is in flight", () => {
    const enterBranch = /if \(e\.key === "Enter" && !e\.shiftKey\)\s*{([\s\S]*?)}/.exec(
      hookSource
    )?.[1]
    expect(enterBranch).toBeDefined()
    expect(enterBranch).toContain("preventDefault")
    expect(enterBranch).toContain("streaming")
  })
})
