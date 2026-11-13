import type { ReactElement, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
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
        hooks.values[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(hooks.values[index])
            : value
      },
    ]
  },
}))

import { ScanProgressScreen } from "./ScanProgressScreen"
import { SetupScreen } from "./SetupScreen"

type ElementProps = {
  children?: ReactNode
  disabled?: boolean
  id?: string
  onClick?: () => unknown
}
type TestElement = ReactElement<ElementProps>

function elements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []

  const element = node as TestElement
  const renderedChildren =
    typeof element.type === "function"
      ? (element.type as (props: unknown) => ReactNode)(element.props)
      : element.props.children
  return [element, ...elements(renderedChildren)]
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as TestElement).props.children)
  }
  return ""
}

function buttonContaining(tree: ReactNode, label: string): TestElement {
  const button = elements(tree).find(
    (element) => element.type === "button" && textOf(element.props.children).includes(label)
  )
  if (!button) throw new Error(`Could not find button containing ${label}`)
  return button
}

function renderSetup() {
  hooks.cursor = 0
  return SetupScreen({ onComplete: vi.fn(), onBack: vi.fn() })
}

describe("Desktop setup and scan status", () => {
  beforeEach(() => {
    hooks.values = []
    hooks.cursor = 0
  })

  it("lets users return from provider credentials to provider choice and runtime setup", async () => {
    hooks.values = [
      "runtime",
      {
        engine: { found: true, path: "/engine", version: "1.0.0" },
        docker: { found: true, running: true, version: "27.0.0" },
      },
      { status: "signed_out" },
      null,
      "",
      "",
      null,
      "",
      false,
      null,
    ]

    let tree = renderSetup()
    await buttonContaining(tree, "Continue").props.onClick?.()
    tree = renderSetup()
    expect(textOf(tree)).toContain("Bring Your Own AI")

    await buttonContaining(tree, "Azure OpenAI").props.onClick?.()
    tree = renderSetup()
    expect(elements(tree).some((element) => element.props.id === "azure-api-key")).toBe(true)

    await buttonContaining(tree, "Back").props.onClick?.()
    tree = renderSetup()
    expect(textOf(tree)).toContain("Choose your AI provider.")

    await buttonContaining(tree, "Back").props.onClick?.()
    tree = renderSetup()
    expect(textOf(tree)).toContain("LyraShield needs the scan engine and Docker")
  })

  it("labels an empty failed scan as failed and keeps the failure details visible", () => {
    hooks.values = []
    hooks.cursor = 0
    hooks.values[2] = "failed"
    hooks.values[5] = "The engine exited unexpectedly."

    const wrapper = ScanProgressScreen({ scanId: "scan-1", onBack: vi.fn() })
    hooks.cursor = 0
    const tree = (wrapper.type as (props: unknown) => ReactNode)(wrapper.props)
    const visibleText = textOf(tree)

    expect(visibleText).toContain("Scan failed. No findings were returned.")
    expect(visibleText).toContain("The engine exited unexpectedly.")
    expect(visibleText).not.toContain("No findings.")
  })
})
