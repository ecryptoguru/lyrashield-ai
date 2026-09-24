import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement, ReactNode } from "react"

// This repository has no DOM test dependency. Exercise the component's real
// hooks and callbacks with a small hook driver, and walk the element tree the
// component returns; the parent acceptance uses a browser.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, hydrated: true }))

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial
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
  // Stand in for React's hydration probe: the server snapshot is returned until
  // the harness says the client has hydrated.
  useSyncExternalStore(
    _subscribe: unknown,
    getSnapshot: () => unknown,
    getServerSnapshot: () => unknown
  ) {
    return hooks.hydrated ? getSnapshot() : getServerSnapshot()
  },
}))

import { ReportVerificationForm } from "./report-verification-form"

type AnyElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>

const FIELD_NAMES = ["reportChecksum", "signature", "sharedReportUrl", "expectedIdentity"] as const
type FieldName = (typeof FIELD_NAMES)[number]

/**
 * The component reads its fields with `new FormData(event.currentTarget)`. Node
 * has FormData but no HTMLFormElement, so the harness supplies a form-shaped
 * stand-in answering the `[name="..."]` lookups the component performs.
 */
function formTarget(values: Partial<Record<FieldName, string>>) {
  return {
    querySelector(selector: string) {
      const name = /\[name="([^"]+)"\]/.exec(selector)?.[1]
      if (!name || !(name in values)) return null
      return { name, value: values[name as FieldName] ?? "" }
    },
  }
}

class HarnessFormData {
  private readonly fields = new Map<string, string>()
  constructor(form?: { querySelector?: (selector: string) => { value?: string } | null }) {
    for (const name of FIELD_NAMES) {
      const field = form?.querySelector?.(`[name="${name}"]`)
      if (field) this.fields.set(name, String(field.value ?? ""))
    }
  }
  get(name: string): string | null {
    return this.fields.get(name) ?? null
  }
}

function isElement(node: unknown): node is AnyElement {
  return Boolean(node) && typeof node === "object" && "props" in (node as object)
}

/**
 * Descend into function components and forwardRef components. DOM element types
 * are strings, so they stay leaves and their children are visited directly.
 * Exactly one of the two is descended — never both — so text is counted once.
 */
function innerOf(element: AnyElement): ReactNode {
  const type = element.type as unknown
  let renderFn: ((props: unknown, ref: unknown) => ReactNode) | undefined
  if (typeof type === "function") {
    renderFn = type as unknown as (props: unknown, ref: unknown) => ReactNode
  } else if (type && typeof type === "object" && "render" in type) {
    renderFn = (type as { render?: (props: unknown, ref: unknown) => ReactNode }).render
  }
  return typeof renderFn === "function" ? renderFn(element.props, null) : element.props.children
}

function walk(node: ReactNode): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(walk)
  if (!isElement(node)) return []
  return [node, ...walk(innerOf(node))]
}

/** Visible text of a subtree, so assertions do not depend on node splitting. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (!isElement(node)) return ""
  return textOf(innerOf(node))
}

function render() {
  hooks.cursor = 0
  return ReportVerificationForm() as AnyElement
}

function renderHtml() {
  return renderToString(render())
}

function findForm() {
  return walk(render()).find((element) => element.type === "form")!
}

function findSubmitButton() {
  return walk(render()).find(
    (element) => element.type === "button" && element.props.type === "submit"
  )!
}

function findByRole(role: string) {
  return walk(render()).find((element) => element.props.role === role)
}

function resultText(): string {
  const status = findByRole("status")
  return status ? textOf(status) : ""
}

function alertText(): string {
  const alert = findByRole("alert")
  return alert ? textOf(alert) : ""
}

const checksum = "a".repeat(64)
const shareToken = "b".repeat(64)
const commit = "c".repeat(40)
const reportId = "cm12345678901234567890123"
const sharedReportUrl = `https://app.lyrashieldai.com/reports/shared/${reportId}?token=${shareToken}`

const fetchMock = vi.fn()

function verifyResponse(data: unknown, ok = true) {
  return { ok, json: async () => ({ success: ok, data }) }
}

async function submit(values: Partial<Record<FieldName, string>>) {
  const form = findForm()
  const onSubmit = form.props.onSubmit as (event: {
    preventDefault: () => void
    currentTarget: unknown
  }) => Promise<void>
  await onSubmit({ preventDefault: vi.fn(), currentTarget: formTarget(values) })
}

describe("report verification form", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hooks.values = []
    hooks.cursor = 0
    hooks.hydrated = true
    vi.stubGlobal("FormData", HarnessFormData)
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("posts the form and disables submit until the component has hydrated", () => {
    hooks.hydrated = false
    const preHydration = findForm()
    // Without method="post" a submit before hydration falls back to the
    // browser's default GET and copies the shared report URL and its share
    // token into the address bar, history and upstream logs.
    expect(preHydration.props.method).toBe("post")
    expect(preHydration.props.action).toBe("")
    expect(findSubmitButton().props.disabled).toBe(true)
    expect(findSubmitButton().props.children).toBe("Loading…")
    expect(renderHtml()).toContain('method="post"')

    hooks.hydrated = true
    expect(findSubmitButton().props.disabled).toBe(false)
    expect(findSubmitButton().props.children).toBe("Verify report")
  })

  it("verifies a signature on its own without sending a release identity", async () => {
    fetchMock.mockResolvedValue(
      verifyResponse({ verified: true, signingKeyId: "lyrashield-launch-report-ed25519-1" })
    )

    await submit({ reportChecksum: checksum, signature: "c2lnbmF0dXJl" })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportChecksum: checksum, signature: "c2lnbmF0dXJl" }),
    })
    expect(resultText()).toContain("Signature valid")
    expect(resultText()).not.toContain("Release identity")
  })

  it.each([
    ["MATCH", "match"],
    ["MISMATCH", "mismatch"],
    ["UNAVAILABLE", "unavailable"],
  ])("reports the %s identity outcome after verification", async (status, label) => {
    fetchMock.mockResolvedValue(
      verifyResponse({
        verified: true,
        signingKeyId: "lyrashield-launch-report-ed25519-1",
        releaseIdentity: { status },
      })
    )

    await submit({
      reportChecksum: checksum,
      signature: "c2lnbmF0dXJl",
      sharedReportUrl,
      expectedIdentity: commit,
    })

    expect(fetchMock).toHaveBeenCalledWith("/api/reports/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reportChecksum: checksum,
        signature: "c2lnbmF0dXJl",
        releaseIdentity: { reportId, shareToken, kind: "COMMIT", value: commit },
      }),
    })
    expect(resultText()).toContain("Signature valid")
    expect(resultText()).toContain(`Release identity: ${label}`)
  })

  it("reads an artifact digest as an ARTIFACT_DIGEST release identity", async () => {
    fetchMock.mockResolvedValue(
      verifyResponse({
        verified: true,
        signingKeyId: "lyrashield-launch-report-ed25519-1",
        releaseIdentity: { status: "MATCH" },
      })
    )

    await submit({
      reportChecksum: checksum,
      signature: "c2lnbmF0dXJl",
      sharedReportUrl,
      expectedIdentity: `sha256:${checksum}`,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reports/verify",
      expect.objectContaining({
        body: JSON.stringify({
          reportChecksum: checksum,
          signature: "c2lnbmF0dXJl",
          releaseIdentity: {
            reportId,
            shareToken,
            kind: "ARTIFACT_DIGEST",
            value: `sha256:${checksum}`,
          },
        }),
      })
    )
  })

  it("keeps an unverified signature from reporting a confirmed identity", async () => {
    fetchMock.mockResolvedValue(
      verifyResponse({
        verified: false,
        signingKeyId: null,
        releaseIdentity: { status: "UNAVAILABLE" },
      })
    )

    await submit({
      reportChecksum: checksum,
      signature: "c2lnbmF0dXJl",
      sharedReportUrl,
      expectedIdentity: commit,
    })

    expect(resultText()).toContain("Signature invalid")
    expect(resultText()).not.toContain("Signature valid")
  })

  it("rejects a release confirmation missing the expected identity without calling the API", async () => {
    await submit({ reportChecksum: checksum, signature: "c2lnbmF0dXJl", sharedReportUrl })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(alertText()).toBe(
      "Provide both a valid shared report URL and the expected commit or digest."
    )
  })

  it("rejects a shared report URL that carries no share token", async () => {
    await submit({
      reportChecksum: checksum,
      signature: "c2lnbmF0dXJl",
      sharedReportUrl: `https://app.lyrashieldai.com/reports/shared/${reportId}`,
      expectedIdentity: commit,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(alertText()).toBe(
      "Provide both a valid shared report URL and the expected commit or digest."
    )
  })

  it("surfaces the API error message when verification fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: { message: "Too many verification requests." } }),
    })

    await submit({ reportChecksum: checksum, signature: "c2lnbmF0dXJl" })

    expect(alertText()).toBe("Too many verification requests.")
    expect(resultText()).toBe("")
  })

  it("surfaces a network failure as an error instead of a result", async () => {
    fetchMock.mockRejectedValue(new Error("Failed to fetch"))

    await submit({ reportChecksum: checksum, signature: "c2lnbmF0dXJl" })

    expect(alertText()).toBe("Failed to fetch")
    expect(resultText()).toBe("")
  })
})
