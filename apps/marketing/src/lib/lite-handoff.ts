import { normalizePublicHttpUrl } from "./public-url"

/**
 * The one Lite Check handoff.
 *
 * Both the hero field and the Lite Check section lower on the page hand the
 * visitor's URL to /scan the same way: validate it, put it in sessionStorage
 * under one key and navigate to /scan?start=1. /scan then reads the key, fills
 * its own field and clears the key, so the typed URL never enters the query
 * string, the referrer or any log.
 *
 * This module is deliberately the single implementation. A second copy is how
 * the two forms would drift apart. A second copy is also how a typed URL
 * would end up somewhere it must not be.
 */

/** Where the handoff parks the target between pages. */
export const LITE_TARGET_KEY = "lyrashield-lite-target"

/** The page that consumes the parked target. */
export const LITE_SCAN_HREF = "/scan?start=1"

export const LITE_URL_ERROR = "Enter a valid public HTTP or HTTPS URL without credentials."

export const LITE_HANDOFF_BLOCKED =
  "Your browser blocked the private handoff. Open the full Lite Check and paste the URL there."

export type LiteHandoffResult = { ok: true } | { ok: false; message: string }

/**
 * Validate the raw field value, park it for /scan and navigate.
 *
 * `navigate` is injectable so a test can assert the handoff without a browser,
 * and so the caller decides how navigation happens. It never receives the
 * target: only the parked key travels with the navigation.
 */
export function submitLiteHandoff(
  rawValue: string,
  options: { navigate?: (href: string) => void } = {}
): LiteHandoffResult {
  const navigate = options.navigate ?? ((href: string) => location.assign(href))
  let target: string
  try {
    target = normalizePublicHttpUrl(rawValue)
  } catch {
    return { ok: false, message: LITE_URL_ERROR }
  }
  try {
    sessionStorage.setItem(LITE_TARGET_KEY, target)
  } catch {
    return { ok: false, message: LITE_HANDOFF_BLOCKED }
  }
  navigate(LITE_SCAN_HREF)
  return { ok: true }
}

/**
 * Wire one form to the handoff. Used by the hero field and by the Lite Check
 * section, so neither carries its own copy of this logic.
 */
export function bindLiteHandoff(options: {
  formId: string
  inputId: string
  errorId: string
  /** The consent box, when the form has one. */
  consentId?: string
  /** Where the error text is written. */
  onError: (message: string) => void
  /** Called before validation, to clear any previous error. */
  onClear?: () => void
  /** Called only when the handoff succeeded. */
  onSuccess?: () => void
}): void {
  const form = document.querySelector<HTMLFormElement>(`#${options.formId}`)
  const input = document.querySelector<HTMLInputElement>(`#${options.inputId}`)
  const consent = options.consentId
    ? document.querySelector<HTMLInputElement>(`#${options.consentId}`)
    : null
  if (!form || !input) return

  form.addEventListener("submit", (event) => {
    event.preventDefault()
    options.onClear?.()
    // Consent is the caller's contract: /scan pre-checks its own box and
    // auto-submits, so a form without recorded consent must never hand off.
    if (consent && !consent.checked) {
      options.onError("Confirm you own this app or have permission to test it.")
      consent.focus()
      return
    }
    const result = submitLiteHandoff(input.value)
    if (!result.ok) {
      options.onError(result.message)
      input.focus()
      return
    }
    options.onSuccess?.()
  })
}
