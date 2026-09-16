import type { ReactElement, ReactNode } from "react"
import { beforeEach, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
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

import { SlotAttendeeStep, SlotPickerView, type MyraComponentContext } from "./myra-presentation"
import type { MyraComponent } from "@lyrashield/myra"

type El = ReactElement<{
  children?: ReactNode
  value?: string
  readOnly?: boolean
  disabled?: boolean
  "aria-readonly"?: boolean | "true" | "false"
  "aria-label"?: string
  onChange?: (event: { target: { value?: string } }) => void
  onClick?: () => void
}>

function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const el = node as El
  return [el, ...elements(el.props?.children)]
}

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as El).props?.children)
  }
  return ""
}

const picker: Extract<MyraComponent, { type: "slot_picker" }> = {
  type: "slot_picker",
  displayTimezone: "Asia/Kolkata",
  slots: [
    { id: "s_1", startsAt: "2030-01-07T16:00:00+05:30", endsAt: "2030-01-07T16:30:00+05:30" },
    { id: "s_2", startsAt: "2030-01-08T16:00:00+05:30", endsAt: "2030-01-08T16:30:00+05:30" },
  ],
}

function ctx(overrides: Partial<MyraComponentContext> = {}): MyraComponentContext {
  return {
    onBookSlot: vi.fn(),
    onConfirm: () => {},
    onCancel: () => {},
    onForgetMemory: () => {},
    proposalStates: {},
    ...overrides,
  }
}

beforeEach(() => {
  hooks.values = []
  hooks.cursor = 0
})

it("a slot click opens the attendee step instead of sending a message", () => {
  hooks.cursor = 0
  let tree = SlotPickerView({ component: picker, context: ctx() })
  // Initial render: the slot grid, no attendee form yet.
  expect(elements(tree).some((e) => e.type === "input")).toBe(false)
  const slotButtons = elements(tree).filter((e) => typeof e.props?.onClick === "function")
  expect(slotButtons.length).toBeGreaterThanOrEqual(2)

  slotButtons[0]!.props.onClick!()
  hooks.cursor = 0
  tree = SlotPickerView({ component: picker, context: ctx() })
  const step = elements(tree).find((e) => e.type === SlotAttendeeStep)
  expect(step).toBeTruthy()
  expect((step!.props as { slot: { startsAt: string } }).slot.startsAt).toBe(
    "2030-01-07T16:00:00+05:30"
  )
})

it("attendee step collects name, email and timezone and submits a bookingRequest", () => {
  const onBookSlot = vi.fn()
  const context = ctx({ onBookSlot })
  const slot = picker.slots[0]!
  const expectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone

  hooks.values = []
  hooks.cursor = 0
  let tree = SlotAttendeeStep({
    slot,
    displayTimezone: picker.displayTimezone,
    context,
    onBack: () => {},
  })

  const inputs = elements(tree).filter((e) => e.type === "input")
  const nameInput = inputs.find((e) => e.props["aria-label"] === "Your name")
  const emailInput = inputs.find((e) => e.props["aria-label"] === "Your email")
  expect(nameInput).toBeTruthy()
  expect(emailInput).toBeTruthy()
  // Anonymous attendee: email is editable.
  expect(emailInput!.props.readOnly ?? false).toBe(false)
  // The resolved browser timezone is shown to the attendee.
  expect(textOf(tree)).toContain(expectedTz)

  // Continue stays disabled until both fields are filled.
  const findContinue = () =>
    elements(tree).find((e) => typeof e.props?.onClick === "function" && textOf(e) === "Continue")
  expect(findContinue()!.props.disabled).toBe(true)

  nameInput!.props.onChange!({ target: { value: "Eval User" } })
  emailInput!.props.onChange!({ target: { value: "eval@example.com" } })
  hooks.cursor = 0
  tree = SlotAttendeeStep({
    slot,
    displayTimezone: picker.displayTimezone,
    context,
    onBack: () => {},
  })
  expect(findContinue()!.props.disabled).toBe(false)
  findContinue()!.props.onClick!()

  expect(onBookSlot).toHaveBeenCalledWith({
    slotStart: "2030-01-07T16:00:00+05:30",
    timezone: expectedTz,
    name: "Eval User",
    email: "eval@example.com",
  })
})

it("prefills and locks the signed-in account email", () => {
  const context = ctx({ attendee: { email: "user@lyrashieldai.com", name: "Signed In" } })
  hooks.values = []
  hooks.cursor = 0
  const tree = SlotAttendeeStep({
    slot: picker.slots[0]!,
    displayTimezone: picker.displayTimezone,
    context,
    onBack: () => {},
  })
  const inputs = elements(tree).filter((e) => e.type === "input")
  const emailInput = inputs.find((e) => e.props["aria-label"] === "Your email")
  const nameInput = inputs.find((e) => e.props["aria-label"] === "Your name")
  expect(emailInput!.props.value).toBe("user@lyrashieldai.com")
  expect(emailInput!.props.readOnly).toBe(true)
  // Name is prefilled but stays editable.
  expect(nameInput!.props.value).toBe("Signed In")
  expect(nameInput!.props.readOnly ?? false).toBe(false)
})
