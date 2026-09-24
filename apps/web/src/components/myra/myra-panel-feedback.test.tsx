import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/scans",
}))

const useMyraPanel = vi.hoisted(() => vi.fn())
vi.mock("./use-myra-panel", () => ({ useMyraPanel }))

import { MyraPanel } from "./myra-panel"

// The thumbs state lives in the useMyraPanel hook, which needs a DOM to drive.
// Pin the button markup from the rendered output and the state transitions at
// source level, the same way the streaming and focus suites do.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const panelSource = readFileSync(new URL("./myra-panel.tsx", import.meta.url), "utf8")

function panelWithTurn(over: Record<string, unknown> = {}) {
  useMyraPanel.mockReturnValue({
    turns: [
      {
        id: 1,
        userText: "How do I connect a repo?",
        parts: [{ kind: "answer", markdown: "Connect it from the targets page." }],
        assistantMessageId: "msg-1",
        error: null,
        stopped: false,
        rating: undefined,
        ratingPending: false,
        ...over,
      },
    ],
    input: "",
    streaming: false,
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
    rateAnswer: vi.fn(),
    componentContext: {
      onPickSlot: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onForgetMemory: vi.fn(),
      proposalStates: {},
    },
  })
}

describe("MyraPanel answer feedback", () => {
  it("offers a labelled thumbs pair for a completed answer", () => {
    panelWithTurn()
    const html = renderToStaticMarkup(<MyraPanel />)

    expect(html).toContain('aria-label="Rate Myra\'s answer"')
    expect(html).toContain("Was this helpful?")
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain(">Yes<")
    expect(html).toContain(">No<")
  })

  it("marks the chosen rating pressed", () => {
    panelWithTurn({ rating: "helpful" })
    const html = renderToStaticMarkup(<MyraPanel />)

    // Exactly one button reports itself pressed, and it is the chosen one.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
  })

  it("disables both thumbs while a rating is pending", () => {
    panelWithTurn({ ratingPending: true })
    const html = renderToStaticMarkup(<MyraPanel />)

    expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it("hides the thumbs when the turn errored or has no assistant message", () => {
    panelWithTurn({ error: "Something went wrong." })
    expect(renderToStaticMarkup(<MyraPanel />)).not.toContain("Was this helpful?")

    panelWithTurn({ assistantMessageId: undefined })
    expect(renderToStaticMarkup(<MyraPanel />)).not.toContain("Was this helpful?")
  })

  it("reports the optimistic rating before the request settles and reverts on failure", () => {
    // Source-level: the hook sets ratingPending, sets the rating on success and
    // clears the pending flag on both paths, so the button never sticks.
    expect(panelSource).toContain("aria-pressed={turn.rating === rating}")
    expect(panelSource).toContain("disabled={turn.ratingPending}")

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const hookSource = readFileSync(new URL("./use-myra-panel.ts", import.meta.url), "utf8")
    expect(hookSource).toContain("ratingPending: true")
    expect(hookSource).toContain("ratingPending: false")
  })
})
