"use client"

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

const RAZORPAY_CHECKOUT_URL = "https://checkout.razorpay.com/v1/checkout.js"

let checkoutScript: Promise<void> | undefined

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  if (checkoutScript) return checkoutScript

  checkoutScript = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = RAZORPAY_CHECKOUT_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Unable to load Razorpay checkout."))
    document.head.appendChild(script)
  })

  return checkoutScript
}

export async function openRazorpaySubscriptionCheckout(params: {
  keyId: string
  subscriptionId: string
  onAuthorized: () => void
}): Promise<void> {
  await loadCheckoutScript()
  if (!window.Razorpay) throw new Error("Razorpay checkout did not initialize.")

  new window.Razorpay({
    key: params.keyId,
    name: "LyraShield AI",
    description: "Cloud subscription",
    subscription_id: params.subscriptionId,
    handler: params.onAuthorized,
  }).open()
}
