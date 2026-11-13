import type { ReactElement, ReactNode } from "react"
import { beforeEach, expect, it, vi } from "vitest"

/**
 * InlineConfirm is a two-step control: the trigger is rendered first, and the
 * destructive confirmation row is created only after the trigger is clicked.
 *
 * This repository has no DOM test dependency, so the component's element tree
 * is rendered directly with controlled hooks and the trigger's own onClick is
 * invoked — the same shape the other interaction suites use. This is the test
 * that proves the confirmation row is reachable; a server-rendered string never
 * contains it, which is why the page-level suites assert only the trigger.
 */
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
        hooks.values[index] = value
      },
    ]
  },
}))

import { InlineConfirm } from "./inline-confirm"

type Element = ReactElement<{
  children?: ReactNode
  onClick?: () => unknown
  disabled?: boolean
  "aria-label"?: string
  role?: string
}>

function isElement(node: unknown): node is Element {
  return Boolean(node) && typeof node === "object" && "props" in (node as object)
}

/**
 * Descend into function and forwardRef components. DOM element types are
 * strings, so they stay leaves and their children are visited directly. Exactly
 * one of the two is descended — never both — so text is counted once.
 */
function innerOf(element: Element): ReactNode {
  const type = element.type as unknown
  let renderFn: ((props: unknown, ref: unknown) => ReactNode) | undefined
  if (typeof type === "function") {
    renderFn = type as unknown as (props: unknown, ref: unknown) => ReactNode
  } else if (type && typeof type === "object" && "render" in type) {
    renderFn = (type as { render?: (props: unknown, ref: unknown) => ReactNode }).render
  }
  return typeof renderFn === "function" ? renderFn(element.props, null) : element.props.children
}

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isElement(node)) return []
  return [node, ...elements(innerOf(node))]
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (!isElement(node)) return ""
  return textOf(innerOf(node))
}

function render(overrides: Partial<Parameters<typeof InlineConfirm>[0]> = {}) {
  hooks.cursor = 0
  return InlineConfirm({
    triggerLabel: "Delete target",
    triggerIcon: <span aria-hidden="true">x</span>,
    confirmLabel: "Stop scan",
    message: "Stop this scan?",
    "aria-label": "Delete this target",
    onConfirm: vi.fn(),
    ...overrides,
  })
}

/** The rendered DOM button whose text contains the label. */
function buttonWith(label: string, overrides: Partial<Parameters<typeof InlineConfirm>[0]> = {}) {
  return elements(render(overrides)).find(
    (element) => element.type === "button" && textOf(element.props.children).includes(label)
  )
}

beforeEach(() => {
  hooks.values = []
})

it("renders only the trigger before any click", () => {
  expect(buttonWith("Delete target")).toBeDefined()
  expect(buttonWith("Stop scan")).toBeUndefined()
  expect(buttonWith("Stop this scan?")).toBeUndefined()
})

it("reveals the confirmation row on the first click and does not confirm yet", async () => {
  const onConfirm = vi.fn()
  await buttonWith("Delete target")!.props.onClick!()

  const tree = elements(render({ onConfirm }))
  const group = tree.find((element) => element.props.role === "group")
  expect(group?.props["aria-label"]).toBe("Stop this scan?")
  expect(buttonWith("Stop scan")).toBeDefined()
  // Revealing the row is not the confirmation.
  expect(onConfirm).not.toHaveBeenCalled()
})

it("confirms only when the destructive control is clicked", async () => {
  const onConfirm = vi.fn()
  const props = { onConfirm }
  await buttonWith("Delete target", props)!.props.onClick!()
  await buttonWith("Stop scan", props)!.props.onClick!()

  expect(onConfirm).toHaveBeenCalledOnce()
  // The row closes again, so the trigger is what renders next.
  expect(buttonWith("Stop scan", props)).toBeUndefined()
})

it("leaves the confirmation row closed while the trigger is disabled", () => {
  const trigger = elements(render({ disabled: true })).find(
    (element) =>
      element.type === "button" && textOf(element.props.children).includes("Delete target")
  )

  expect(trigger!.props.disabled).toBe(true)
  expect(buttonWith("Stop scan")).toBeUndefined()
})
