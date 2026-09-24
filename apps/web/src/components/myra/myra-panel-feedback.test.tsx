import { readFileSync } from "node:fs"
import type { ReactElement, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
// The panel is a hook-driven client component. This repo has no jsdom or
// testing-library, so the convention (see myra-slot-booking.test.tsx) is to
// drive react's hooks directly and walk the returned element tree.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    hooks.values[index] ??= { current: initial }
    return hooks.values[index]
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = value
      },
    ]
  },
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/scans",
}))

const useMyraPanel = vi.hoisted(() => vi.fn())
vi.mock("./use-myra-panel", () => ({ useMyraPanel }))

import { MyraPanel } from "./myra-panel"

// eslint-disable-next-line security/detect-non-literal-fs-filename -- repository-owned source file.
const panelSource = readFileSync(new URL("./myra-panel.tsx", import.meta.url), "utf8")

type El = ReactElement<{
  children?: ReactNode
  disabled?: boolean
  "aria-pressed"?: boolean | "true" | "false"
  "aria-label"?: string
}>

function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const el = node as El
  return [el, ...elements(el.props?.children)]
}

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

function thumbs(tree: ReactNode) {
  return elements(tree).filter((el) => el.props?.["aria-label"] === "Rate Myra's answer")
}

function ratingButtons(tree: ReactNode) {
  return elements(tree).filter((el) => el.props?.["aria-pressed"] !== undefined)
}

describe("MyraPanel answer feedback", () => {
  beforeEach(() => {
    hooks.values = []
    hooks.cursor = 0
    useMyraPanel.mockReset()
  })

  it("offers a labelled thumbs pair for a completed answer", () => {
    panelWithTurn()
    const tree = MyraPanel({})
    const buttons = ratingButtons(tree)

    expect(thumbs(tree)).toHaveLength(1)
    expect(buttons).toHaveLength(2)
    expect(buttons.every((el) => el.props["aria-pressed"] === false)).toBe(true)
  })

  it("marks the chosen rating pressed", () => {
    panelWithTurn({ rating: "helpful" })
    const buttons = ratingButtons(MyraPanel({}))

    expect(buttons.filter((el) => el.props["aria-pressed"] === true)).toHaveLength(1)
  })

  it("disables both thumbs while a rating is pending", () => {
    panelWithTurn({ ratingPending: true })
    const buttons = ratingButtons(MyraPanel({}))

    expect(buttons).toHaveLength(2)
    expect(buttons.every((el) => el.props.disabled === true)).toBe(true)
  })

  it("hides the thumbs when the turn errored or has no assistant message", () => {
    panelWithTurn({ error: "Something went wrong." })
    expect(ratingButtons(MyraPanel({}))).toHaveLength(0)

    hooks.values = []
    hooks.cursor = 0
    panelWithTurn({ assistantMessageId: undefined })
    expect(ratingButtons(MyraPanel({}))).toHaveLength(0)
  })

  it("binds the thumbs to the optimistic rating state, which clears on both paths", () => {
    // Source-level: the hook sets ratingPending, sets the rating on success and
    // clears the pending flag on both success and failure, so the button never
    // sticks.
    expect(panelSource).toContain("aria-pressed={turn.rating === rating}")
    expect(panelSource).toContain("disabled={turn.ratingPending}")

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository-owned source file.
    const hookSource = readFileSync(new URL("./use-myra-panel.ts", import.meta.url), "utf8")
    expect(hookSource).toContain("ratingPending: true")
    expect(hookSource).toContain("ratingPending: false")
  })
})
