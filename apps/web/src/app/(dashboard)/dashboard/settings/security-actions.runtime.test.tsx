import type { ReactElement, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
const auth = vi.hoisted(() => ({ enable: vi.fn(), verifyTotp: vi.fn(), refresh: vi.fn() }))
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }))
const controls = vi.hoisted(() => ({
  Button: function Button() {},
  Input: function Input() {},
  PasswordInput: function PasswordInput() {},
  QRCodeSVG: function QRCodeSVG() {},
}))

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: auth.refresh }) }))
vi.mock("@lyrashield/auth", () => ({
  authClient: { twoFactor: { enable: auth.enable, verifyTotp: auth.verifyTotp } },
  getAuthErrorMessage: () => "Authentication failed",
}))
vi.mock("@/lib/api-client", () => ({
  apiGet: api.get,
  apiPost: api.post,
  apiDelete: api.delete,
  ApiError: class ApiError extends Error {},
}))
vi.mock("@/components/password-input", () => ({ PasswordInput: controls.PasswordInput }))
vi.mock("qrcode.react", () => ({ QRCodeSVG: controls.QRCodeSVG }))
vi.mock("@/components/scorecard-share-composer", () => ({ writeClipboard: vi.fn() }))
vi.mock("@lyrashield/ui", () => ({
  Button: controls.Button,
  Input: controls.Input,
  Badge: function Badge() {},
  Card: function Card() {},
  CardContent: function CardContent() {},
  CardHeader: function CardHeader() {},
  CardTitle: function CardTitle() {},
  EmptyState: function EmptyState() {},
  FormField: function FormField() {},
  Spinner: function Spinner() {},
}))

import { TwoFactorSecurity } from "./two-factor-security"
import { ApiKeysSection } from "./api-keys"

type Element = ReactElement<{
  children?: ReactNode
  id?: string
  name?: string
  checked?: boolean
  value?: string
  "aria-label"?: string
  "aria-controls"?: string
  onChange?: (event: { target: { value: string } }) => void
  onClick?: () => void
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>
}>

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

function textContent(node: ReactNode): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textContent).join("")
  if (!node || typeof node !== "object" || !("props" in node)) return ""
  return textContent((node as Element).props.children)
}

function renderTwoFactor(): Element[] {
  hooks.cursor = 0
  return elements(TwoFactorSecurity({ enabled: false }))
}

function renderApiKeys(): Element[] {
  hooks.cursor = 0
  return elements(ApiKeysSection({ workspaceId: "workspace-1", canManage: true }))
}

describe("security settings request bodies", () => {
  beforeEach(() => {
    hooks.values = []
    hooks.cursor = 0
    vi.clearAllMocks()
  })

  it("enrolls TOTP with a password and verifies without trusting the device", async () => {
    auth.enable.mockResolvedValue({
      data: { method: "totp", totpURI: "otpauth://totp/test", backupCodes: ["backup-1"] },
      error: null,
    })
    auth.verifyTotp.mockResolvedValue({ error: null })

    renderTwoFactor()
      .find((element) => element.type === controls.PasswordInput)
      ?.props.onChange?.({ target: { value: "current-password" } })
    const begin = renderTwoFactor().find((element) => element.type === "form")
    await begin?.props.onSubmit?.({ preventDefault: vi.fn() })
    expect(auth.enable).toHaveBeenCalledExactlyOnceWith({
      password: "current-password",
      method: "totp",
    })

    const setupTree = renderTwoFactor()
    expect(setupTree.find((element) => element.type === controls.QRCodeSVG)?.props.value).toBe(
      "otpauth://totp/test"
    )
    expect(
      setupTree.find((element) => element.props["aria-label"] === "Authenticator setup URI")?.props
        .value
    ).toBe("otpauth://totp/test")
    expect(setupTree.some((element) => textContent(element.props.children) === "backup-1")).toBe(
      true
    )

    setupTree
      .find((element) => element.props.id === "enrollment-code")
      ?.props.onChange?.({ target: { value: "123456" } })
    const finish = renderTwoFactor().find((element) => element.type === "form")
    await finish?.props.onSubmit?.({ preventDefault: vi.fn() })
    expect(auth.verifyTotp).toHaveBeenCalledExactlyOnceWith({
      code: "123456",
      trustDevice: false,
    })
    expect(auth.refresh).toHaveBeenCalledOnce()
  })

  it("sends read-only scope after a write selection is cancelled", async () => {
    api.get.mockResolvedValue([])
    api.post.mockResolvedValue({ id: "key-1", rawKey: "key-secret", scopes: ["read"] })

    renderApiKeys()
      .find((element) => element.props["aria-controls"] === "api-key-create-form")
      ?.props.onClick?.()
    renderApiKeys()
      .filter((element) => element.type === "input" && element.props.name === "api-key-scope")[1]
      ?.props.onChange?.({ target: { value: "write" } })
    expect(
      renderApiKeys().filter(
        (element) => element.type === "input" && element.props.name === "api-key-scope"
      )[1]?.props.checked
    ).toBe(true)
    renderApiKeys()
      .find(
        (element) =>
          element.type === controls.Button && textContent(element.props.children) === "Cancel"
      )
      ?.props.onClick?.()
    renderApiKeys()
      .find((element) => element.props["aria-controls"] === "api-key-create-form")
      ?.props.onClick?.()
    renderApiKeys()
      .find((element) => element.props.id === "api-key-name")
      ?.props.onChange?.({ target: { value: "Automation" } })
    renderApiKeys()
      .find(
        (element) =>
          element.type === controls.Button && textContent(element.props.children) === "Create key"
      )
      ?.props.onClick?.()
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledOnce())
    expect(api.post).toHaveBeenCalledWith(
      "/api/api-keys",
      { workspaceId: "workspace-1", name: "Automation", scopes: ["read"] },
      expect.any(Object)
    )
  })
})
