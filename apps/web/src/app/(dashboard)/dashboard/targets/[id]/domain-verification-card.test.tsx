import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

// This repository has no DOM test dependency. Exercise the component's real
// callbacks with a small hook driver; the parent acceptance uses a browser.
const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[],
  buttons: new Map<string, { onClick?: () => void; disabled?: boolean }>(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  refresh: vi.fn(),
  copy: vi.fn(),
}))
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const index = harness.index++
    if (!(index in harness.values))
      harness.values[index] = typeof initial === "function" ? initial() : initial
    return [
      harness.values[index],
      (value: unknown) => {
        harness.values[index] = typeof value === "function" ? value(harness.values[index]) : value
      },
    ]
  },
  useEffect(effect: () => void | (() => void)) {
    harness.effects.push(effect)
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: harness.refresh }) }))
vi.mock("@/lib/api-client", () => ({
  apiGet: harness.get,
  apiPost: harness.post,
  apiPut: harness.put,
}))
vi.mock("@lyrashield/ui", () => ({
  Card: ({ children, ...props }: { children: ReactNode }) => (
    <section {...props}>{children}</section>
  ),
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
    size?: string
    "aria-label"?: string
  }) => {
    harness.buttons.set(props["aria-label"] ?? String(children), { onClick, disabled })
    return (
      <button onClick={onClick} disabled={disabled}>
        {children}
      </button>
    )
  },
}))
import { DomainVerificationCard } from "./domain-verification-card"
const defaults = {
  workspaceId: "ws1",
  domain: "app.example.com",
  canValidate: true,
  initialStatus: "Self-attested",
}
const proof = {
  id: "p1",
  domain: "app.example.com",
  method: "DNS_TXT",
  status: "PENDING",
  expiresAt: "2099-01-01T00:00:00Z",
}
function render(props = defaults) {
  harness.index = 0
  harness.effects = []
  harness.buttons.clear()
  return renderToString(<DomainVerificationCard {...props} />)
}
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
async function load(rows: unknown[] = []) {
  harness.get.mockResolvedValueOnce(rows)
  render()
  harness.effects[1]!()
  await settle()
  return render()
}

describe("domain verification card", () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.clearAllMocks()
    harness.values = []
    harness.index = 0
    harness.effects = []
    harness.buttons.clear()
    vi.stubGlobal("navigator", { clipboard: { writeText: harness.copy } })
  })
  it("renders permission denial without mutation controls or requests", () => {
    const html = render({ ...defaults, canValidate: false })
    expect(html).toContain("target validation permission")
    expect(html).toContain("Self-attested")
    expect(harness.buttons.size).toBe(0)
    expect(harness.get).not.toHaveBeenCalled()
  })
  it("loads scoped proof metadata and explains missing token recovery", async () => {
    const html = await load([proof])
    expect(harness.get).toHaveBeenCalledWith(
      "/api/target-domain-verifications?workspaceId=ws1",
      expect.objectContaining({ cache: "no-store" })
    )
    expect(html).toContain("reissue if you did not save it")
    expect(html).not.toContain("TXT value</")
    expect(harness.buttons.get("Verify now")?.disabled).toBe(false)
  })
  it("issues, independently copies both DNS fields, and verifies with expiry", async () => {
    await load([{ ...proof, status: "VERIFIED" }])
    harness.post.mockResolvedValueOnce({
      verification: proof,
      dns: { host: "_lyrashield.app.example.com", value: "fixture-token" },
    })
    harness.buttons.get("Issue proof")!.onClick!()
    await settle()
    let html = render()
    expect(html).toContain("Not verified")
    expect(html).toContain("previous proof is invalid")
    expect(harness.post).toHaveBeenCalledWith(
      "/api/target-domain-verifications",
      { workspaceId: "ws1", domain: "app.example.com" },
      expect.any(Object)
    )
    harness.buttons.get("Copy DNS host")!.onClick!()
    await settle()
    harness.buttons.get("Copy TXT value")!.onClick!()
    await settle()
    expect(harness.copy.mock.calls).toEqual([["_lyrashield.app.example.com"], ["fixture-token"]])
    harness.put.mockResolvedValueOnce({ ...proof, status: "VERIFIED" })
    harness.buttons.get("Verify now")!.onClick!()
    await settle()
    html = render()
    expect(harness.put).toHaveBeenCalledWith(
      "/api/target-domain-verifications",
      { workspaceId: "ws1", verificationId: "p1" },
      expect.any(Object)
    )
    expect(html).toContain("Domain verified successfully.")
    expect(html).toContain("Verified until")
  })
  it("does not show an expired proof as verified or checkable", async () => {
    const html = await load([{ ...proof, status: "VERIFIED", expiresAt: "2000-01-01T00:00:00Z" }])
    expect(html).toContain("Not verified (expired)")
    expect(harness.buttons.get("Verify now")?.disabled).toBe(true)
  })
  it("shows API failures accessibly", async () => {
    await load([proof])
    harness.put.mockRejectedValueOnce(new Error("DNS record not found"))
    harness.buttons.get("Verify now")!.onClick!()
    await settle()
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain("DNS record not found")
    expect(html).not.toContain("Domain verified successfully")
  })
  it("offers manual copy when clipboard permission is denied", async () => {
    await load()
    harness.post.mockResolvedValueOnce({
      verification: proof,
      dns: { host: "_lyrashield.app.example.com", value: "fixture-token" },
    })
    harness.buttons.get("Issue proof")!.onClick!()
    await settle()
    render()
    harness.copy.mockRejectedValueOnce(new Error("denied"))
    harness.buttons.get("Copy TXT value")!.onClick!()
    await settle()
    expect(render()).toContain("Select and copy the displayed value manually")
  })
  it("ignores a late lookup after workspace unmount", async () => {
    let resolve!: (value: unknown[]) => void
    harness.get.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    render()
    const cleanup = harness.effects[1]!()
    if (typeof cleanup === "function") cleanup()
    resolve([proof])
    await settle()
    expect(harness.values[0]).toBeNull()
  })
})
