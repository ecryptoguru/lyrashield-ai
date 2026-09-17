/**
 * Item 1.5 — the marketing slot_picker opens an inline attendee step and
 * submits a structured bookingRequest (no natural-language parsing). Runs
 * under the marketing Vitest suite against a minimal fake document.
 */
import { beforeAll, describe, expect, it, vi } from "vitest"

interface FakeText {
  textContent: string
}

interface FakeEl {
  tagName: string
  className: string
  textContent: string
  value: string
  type: string
  hidden: boolean
  disabled: boolean
  readOnly: boolean
  attrs: Record<string, string>
  children: (FakeEl | FakeText)[]
  listeners: Record<string, (() => void)[]>
  appendChild(child: FakeEl | FakeText): FakeEl | FakeText
  addEventListener(type: string, fn: () => void): void
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  remove(): void
  focus(): void
  click(): void
}

function fakeEl(tag: string): FakeEl {
  return {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    value: "",
    type: "",
    hidden: false,
    disabled: false,
    readOnly: false,
    attrs: {},
    children: [],
    listeners: {},
    appendChild(child) {
      this.children.push(child as FakeEl)
      return child
    },
    addEventListener(type, fn) {
      ;(this.listeners[type] ??= []).push(fn)
    },
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    removeAttribute(name) {
      delete this.attrs[name]
    },
    remove() {},
    focus() {},
    click() {
      for (const fn of this.listeners.click ?? []) fn()
    },
  }
}

function walk(root: FakeEl): FakeEl[] {
  return [root, ...root.children.flatMap((c) => ("tagName" in c ? walk(c) : []))]
}

function textOf(root: FakeEl): string {
  const parts: string[] = [root.textContent ?? ""]
  for (const c of root.children) {
    parts.push("tagName" in c ? textOf(c) : String(c.textContent ?? ""))
  }
  return parts.join(" ")
}

beforeAll(() => {
  ;(globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => fakeEl(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  }
})

import {
  renderMyraComponent,
  type MyraDomRendererContext,
} from "../components/myra/myra-dom-renderer"

const SLOT = {
  id: "s_1",
  startsAt: "2030-01-07T16:00:00+05:30",
  endsAt: "2030-01-07T16:30:00+05:30",
}

function context(send: MyraDomRendererContext["send"]): MyraDomRendererContext {
  return {
    client: {} as MyraDomRendererContext["client"],
    apiBase: "https://app.lyrashieldai.com",
    announce: () => {},
    send,
    markActionCompleted: () => {},
    setLastTraceId: () => {},
  }
}

describe("marketing slot_picker attendee step", () => {
  it("opens name/email inputs on slot click and submits a bookingRequest", () => {
    const send = vi.fn<(text: string, bookingRequest?: Record<string, unknown>) => void>()
    const host = fakeEl("div")
    renderMyraComponent(
      {
        type: "slot_picker",
        displayTimezone: "Asia/Kolkata",
        slots: [SLOT],
      },
      host as unknown as HTMLElement,
      context(send)
    )

    const slotBtn = walk(host).find(
      (n) => n.tagName === "BUTTON" && n.className === "myra-btn" && textOf(n).length > 0
    )
    expect(slotBtn).toBeTruthy()

    // The click must NOT send a chat message yet — the attendee step opens.
    slotBtn!.click()
    expect(send).not.toHaveBeenCalled()

    const all = walk(host)
    const nameInput = all.find((n) => n.attrs["aria-label"] === "Your name")
    const emailInput = all.find((n) => n.attrs["aria-label"] === "Your email")
    expect(nameInput).toBeTruthy()
    expect(emailInput).toBeTruthy()
    // The attendee's browser timezone is surfaced.
    const expectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(textOf(host)).toContain(expectedTz)

    nameInput!.value = "Eval User"
    emailInput!.value = "eval@example.com"
    const continueBtn = all.find((n) => n.tagName === "BUTTON" && textOf(n).trim() === "Continue")
    expect(continueBtn).toBeTruthy()
    continueBtn!.click()

    expect(send).toHaveBeenCalledTimes(1)
    const [text, bookingRequest] = send.mock.calls[0] as [string, Record<string, unknown>]
    expect(typeof text).toBe("string")
    expect(bookingRequest).toEqual({
      slotStart: "2030-01-07T16:00:00+05:30",
      timezone: expectedTz,
      name: "Eval User",
      email: "eval@example.com",
    })
  })
})
