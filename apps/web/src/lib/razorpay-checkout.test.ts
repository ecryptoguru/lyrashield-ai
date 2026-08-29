import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type ScriptStub = {
  src: string
  async: boolean
  onload: (() => void) | null
  onerror: (() => void) | null
  remove: ReturnType<typeof vi.fn>
}

const scripts: ScriptStub[] = []

beforeEach(() => {
  vi.resetModules()
  scripts.length = 0
  vi.stubGlobal("window", {})
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      const script: ScriptStub = {
        src: "",
        async: false,
        onload: null,
        onerror: null,
        remove: vi.fn(),
      }
      scripts.push(script)
      return script
    }),
    head: { appendChild: vi.fn() },
  })
})

afterEach(() => vi.unstubAllGlobals())

describe("openRazorpaySubscriptionCheckout", () => {
  it("removes a failed loader and permits a clean retry", async () => {
    const { openRazorpaySubscriptionCheckout } = await import("./razorpay-checkout")

    const firstAttempt = openRazorpaySubscriptionCheckout({
      keyId: "rzp_test_key",
      subscriptionId: "sub_1",
      onAuthorized: vi.fn(),
    })
    scripts[0]!.onerror?.()
    await expect(firstAttempt).rejects.toThrow("Unable to load Razorpay checkout.")
    expect(scripts[0]!.remove).toHaveBeenCalledOnce()

    const retry = openRazorpaySubscriptionCheckout({
      keyId: "rzp_test_key",
      subscriptionId: "sub_1",
      onAuthorized: vi.fn(),
    })
    expect(scripts).toHaveLength(2)

    const checkout = { open: vi.fn() }
    const construct = vi.fn()
    class Razorpay {
      constructor(options: { modal: { ondismiss: () => void } }) {
        construct(options)
        checkout.open.mockImplementationOnce(options.modal.ondismiss)
      }

      open() {
        checkout.open()
      }
    }
    Object.assign(window, { Razorpay })
    scripts[1]!.onload?.()

    await expect(retry).resolves.toBeUndefined()
    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({ key: "rzp_test_key", subscription_id: "sub_1" })
    )
    expect(checkout.open).toHaveBeenCalledOnce()
  })
})
