import type { ReactElement, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  effects: [] as Array<() => void>,
}))
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }))
const analytics = vi.hoisted(() => ({
  analyticsCookiePreference: vi.fn(),
  analyticsOptedOut: vi.fn(),
  clearOptionalTrackingCookiesInBrowser: vi.fn(),
  setAnalyticsPreference: vi.fn(),
  writeAnalyticsPreferenceCookie: vi.fn(),
}))
const controls = vi.hoisted(() => ({
  Button: function Button() {},
  Card: function Card() {},
  CardContent: function CardContent() {},
  CardHeader: function CardHeader() {},
  CardTitle: function CardTitle() {},
  Spinner: function Spinner() {},
  Switch: function Switch() {},
}))

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void) => {
      hooks.effects.push(fn)
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
  }
})
vi.mock("@/lib/api-client", () => ({ apiGet: api.get, apiPatch: api.patch }))
vi.mock("@/lib/analytics", () => analytics)
vi.mock("@lyrashield/ui", () => controls)

import { AnalyticsPreferences } from "./analytics-preferences"

type Element = ReactElement<{
  children?: ReactNode
  checked?: boolean
  disabled?: boolean
  onCheckedChange?: (checked: boolean) => unknown
  onClick?: () => unknown
  [key: string]: unknown
}>

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

function render(): Element[] {
  hooks.cursor = 0
  hooks.effects = []
  return elements(AnalyticsPreferences())
}

function toggle(tree: Element[]): Element {
  const found = tree.find((element) => element.type === controls.Switch)
  if (!found) throw new Error("Analytics preference switch was not rendered")
  return found
}

function status(tree: Element[]): string {
  const found = tree.find((element) => element.props["aria-live"] === "polite")
  return typeof found?.props.children === "string" ? found.props.children : ""
}

async function loadPreference(analyticsEnabled: boolean): Promise<void> {
  api.get.mockResolvedValue({ analyticsEnabled })
  render()
  await hooks.effects[0]?.()
  await Promise.resolve()
  render()
}

describe("AnalyticsPreferences", () => {
  beforeEach(() => {
    hooks.cursor = 0
    hooks.values = []
    hooks.effects = []
    api.get.mockReset()
    api.patch.mockReset()
    analytics.analyticsCookiePreference.mockReset().mockReturnValue("on")
    analytics.analyticsOptedOut.mockReset().mockReturnValue(false)
    analytics.clearOptionalTrackingCookiesInBrowser.mockReset()
    analytics.setAnalyticsPreference.mockReset()
    analytics.writeAnalyticsPreferenceCookie.mockReset()
    vi.unstubAllGlobals()
    vi.stubGlobal("document", { cookie: "lyrashield-analytics=on" })
    vi.stubGlobal("navigator", { doNotTrack: null, globalPrivacyControl: false })
  })

  it("reports account and browser choices separately", async () => {
    await loadPreference(false)
    const accountOff = render()
    expect(status(accountOff)).toBe("Disabled for this account across devices.")
    expect(toggle(accountOff).props.checked).toBe(false)
    expect(toggle(accountOff).props.disabled).toBe(false)

    hooks.values = []
    hooks.cursor = 0
    analytics.analyticsOptedOut.mockReturnValue(false)
    api.get.mockReset()
    api.patch.mockReset()
    analytics.analyticsCookiePreference.mockReturnValue("off")
    await loadPreference(true)
    const browserOff = render()
    expect(status(browserOff)).toBe("Disabled in this browser.")
    expect(toggle(browserOff).props.disabled).toBe(false)
  })

  it("shows DNT/GPC as an effective, untoggleable opt-out", async () => {
    analytics.analyticsOptedOut.mockReturnValue(true)
    await loadPreference(true)
    const tree = render()
    expect(status(tree)).toContain("Blocked by your browser")
    expect(toggle(tree).props.checked).toBe(false)
    expect(toggle(tree).props.disabled).toBe(true)
  })

  it("shows a retry after a failed load and applies the successful retry", async () => {
    api.get.mockRejectedValueOnce(new Error("preference load failed"))
    render()
    await hooks.effects[0]?.()
    await Promise.resolve()
    await Promise.resolve()

    const failed = render()
    expect(failed.some((element) => element.props.role === "alert")).toBe(true)
    expect(status(failed)).toBe("Unable to confirm your analytics preference.")
    const retry = failed.find((element) => element.type === controls.Button)
    expect(retry?.props.children).toBe("Retry")

    api.get.mockResolvedValueOnce({ analyticsEnabled: false })
    if (typeof retry?.props.onClick !== "function")
      throw new Error("Retry handler was not rendered")
    await retry.props.onClick()

    expect(status(render())).toBe("Disabled for this account across devices.")
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("keeps the loading state while the preference request is delayed", async () => {
    let resolvePreference: ((value: { analyticsEnabled: boolean }) => void) | undefined
    api.get.mockReturnValueOnce(
      new Promise<{ analyticsEnabled: boolean }>((resolve) => {
        resolvePreference = resolve
      })
    )
    render()
    await hooks.effects[0]?.()
    await Promise.resolve()

    const pending = render()
    expect(pending.some((element) => element.props.role === "status")).toBe(true)
    resolvePreference?.({ analyticsEnabled: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(status(render())).toBe("Enabled for this account and browser.")
  })

  it("clears browser tracking immediately and preserves off through a failed save retry", async () => {
    await loadPreference(true)
    api.patch.mockRejectedValueOnce(new Error("save failed")).mockResolvedValueOnce({
      analyticsEnabled: false,
    })
    const preferenceSwitch = toggle(render())
    const save = preferenceSwitch.props.onCheckedChange
    if (typeof save !== "function") throw new Error("Switch handler was not rendered")

    const firstAttempt = save(false)
    expect(analytics.writeAnalyticsPreferenceCookie).toHaveBeenCalledWith(false)
    expect(analytics.clearOptionalTrackingCookiesInBrowser).toHaveBeenCalledOnce()
    expect(analytics.setAnalyticsPreference).toHaveBeenCalledWith(false)
    expect(toggle(render()).props.checked).toBe(false)
    await firstAttempt

    const retryButton = render().find(
      (element) => element.type === controls.Button && element.props.children === "Retry save"
    )
    expect(retryButton).toBeDefined()
    await retryButton?.props.onClick?.()

    expect(api.patch).toHaveBeenNthCalledWith(1, "/api/account/preferences", {
      analyticsEnabled: false,
    })
    expect(api.patch).toHaveBeenNthCalledWith(2, "/api/account/preferences", {
      analyticsEnabled: false,
    })
    expect(analytics.setAnalyticsPreference).toHaveBeenLastCalledWith(false)
    expect(toggle(render()).props.checked).toBe(false)
  })
})
