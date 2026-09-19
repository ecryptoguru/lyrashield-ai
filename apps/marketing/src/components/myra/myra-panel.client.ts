/**
 * Myra panel client — lazy chunk. Imported dynamically by MyraPanel.astro on
 * first open only; nothing here (and no network call) runs before that.
 *
 * Rendering rules: only allowlisted components render; all model text goes
 * through sanitizeMarkdown/escapeHtml or textContent. No innerHTML with model
 * content anywhere in this module.
 */
import { createMyraClient, isManifestRoute, MYRA_COPY, type MyraClient } from "@lyrashield/myra"
import { openMyraCaseComposer } from "./myra-case-composer"
import { createMyraConversation, type MyraConversation } from "./myra-conversation"
import type { MyraDomRendererContext } from "./myra-dom-renderer"
import { myraApiBase, getMyraToken, getMyraSessionMemory, ensureMyraSession } from "./myra-session"
import { initMyraSuggestions } from "./myra-suggestions"

const apiBase = myraApiBase()

/** Route context is an allowlisted path identifier, never scraped DOM text. */
function routeContextFor(pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (isManifestRoute(path, "marketing")) return path
  const first = `/${path.split("/")[1] ?? ""}`
  return isManifestRoute(first, "marketing") ? first : undefined
}

export function initMyraPanel() {
  const launcher = document.getElementById("myra-launcher") as HTMLButtonElement | null
  const panel = document.getElementById("myra-panel")
  const closeBtn = document.getElementById("myra-close") as HTMLButtonElement | null
  const talkBtn = document.getElementById("myra-talk") as HTMLButtonElement | null
  const log = document.getElementById("myra-log")
  const emptyEl = document.getElementById("myra-empty")
  const startersEl = document.getElementById("myra-starters")
  const form = document.getElementById("myra-form") as HTMLFormElement | null
  const input = document.getElementById("myra-input") as HTMLTextAreaElement | null
  const sendBtn = document.getElementById("myra-send") as HTMLButtonElement | null
  const stopBtn = document.getElementById("myra-stop") as HTMLButtonElement | null
  const activityEl = document.getElementById("myra-activity")
  const statusEl = document.getElementById("myra-status")
  const suggestEl = document.getElementById("myra-suggest")
  const disclosureEl = document.getElementById("myra-disclosure")
  if (!launcher || !panel || !log || !form || !input) return { open: () => {} }
  // const-capture narrowing into the closures below is reliable only through a
  // post-guard alias — bind the narrowed elements once.
  const logEl = log
  const inputEl = input
  const formEl = form
  const panelEl = panel
  const launcherEl = launcher

  const routeContext = routeContextFor(window.location.pathname)

  if (disclosureEl && window.location.pathname.startsWith("/tools")) {
    disclosureEl.textContent = MYRA_COPY.toolPageDisclosure
    disclosureEl.hidden = false
  }

  const client: MyraClient = createMyraClient({
    apiBase,
    surface: "MARKETING",
    getPublicToken: getMyraToken,
    getSessionMemory: getMyraSessionMemory,
    routeContext,
  })

  let open = false
  let bootstrapped = false
  let restoredFocus: HTMLElement | null = null
  let conversation: MyraConversation
  const mobile = window.matchMedia("(max-width: 639px)")
  const previousInert = new Map<HTMLElement, boolean>()
  let previousOverflow = ""

  function updateModal() {
    const modal = open && mobile.matches
    panelEl.setAttribute("aria-modal", String(modal))
    if (modal && previousInert.size === 0) {
      previousOverflow = document.body.style.overflow
      document.body.style.overflow = "hidden"
      for (const child of document.body.children) {
        if (
          !(child instanceof HTMLElement) ||
          child === panelEl ||
          child.matches("[data-myra-turnstile]")
        )
          continue
        previousInert.set(child, child.inert)
        child.inert = true
      }
      const active = document.activeElement
      const challengeHost = document.querySelector("body > [data-myra-turnstile]")
      if (!panelEl.contains(active) && !challengeHost?.contains(active)) inputEl.focus()
    } else if (!modal && previousInert.size > 0) {
      for (const [child, wasInert] of previousInert) child.inert = wasInert
      previousInert.clear()
      document.body.style.overflow = previousOverflow
    }
  }

  mobile.addEventListener("change", updateModal)

  const rendererContext: MyraDomRendererContext = {
    client,
    apiBase,
    announce,
    send: (text, bookingRequest) => void conversation.send(text, bookingRequest),
    markActionCompleted: () => conversation.markActionCompleted(),
    setLastTraceId: (traceId) => conversation.setLastTraceId(traceId),
  }

  function announce(text: string) {
    if (statusEl) statusEl.textContent = text
  }

  function setActivity(label: string | null) {
    if (!activityEl) return
    if (label) {
      activityEl.textContent = label
      activityEl.hidden = false
      logEl.setAttribute("aria-busy", "true")
    } else {
      activityEl.textContent = ""
      activityEl.hidden = true
      logEl.removeAttribute("aria-busy")
    }
  }

  function nearBottom(): boolean {
    return logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 80
  }

  function scrollToBottom() {
    logEl.scrollTop = logEl.scrollHeight
  }

  function setStreaming(on: boolean) {
    if (sendBtn) sendBtn.hidden = on
    if (stopBtn) stopBtn.hidden = !on
    inputEl.setAttribute("aria-disabled", on ? "true" : "false")
  }

  async function bootstrapSession(): Promise<void> {
    await ensureMyraSession(apiBase)
  }

  const suggestions = initMyraSuggestions({
    client,
    inputEl,
    suggestEl,
    logEl,
    emptyEl,
    scrollToBottom,
    announce,
    onSubmit: () => formEl.requestSubmit(),
  })

  conversation = createMyraConversation({
    client,
    bootstrapSession,
    rendererContext,
    logEl,
    emptyEl,
    inputEl,
    beforeSend: suggestions.hideSuggest,
    setStreaming,
    setActivity,
    announce,
    nearBottom,
    scrollToBottom,
  })

  function openPanel() {
    if (open) return
    open = true
    restoredFocus = (document.activeElement as HTMLElement) ?? launcherEl
    panelEl.hidden = false
    launcherEl.hidden = true
    launcherEl.setAttribute("aria-expanded", "true")
    updateModal()
    if (!bootstrapped) {
      bootstrapped = true
      bootstrapSession().catch(() => {
        /* message send retries bootstrap inline */
      })
    }
    inputEl.focus()
    announce("Myra panel opened.")
  }

  function closePanel() {
    if (!open) return
    open = false
    conversation.stopStream()
    suggestions.hideSuggest()
    panelEl.hidden = true
    launcherEl.hidden = false
    launcherEl.setAttribute("aria-expanded", "false")
    updateModal()
    ;(restoredFocus ?? launcherEl).focus()
    announce("Myra panel closed.")
  }

  function openCaseComposer() {
    openMyraCaseComposer({
      apiBase,
      logEl,
      emptyEl,
      getLastTraceId: conversation.getLastTraceId,
      scrollToBottom,
      announce,
      send: (text) => void conversation.send(text),
    })
  }

  formEl.addEventListener("submit", (e) => {
    e.preventDefault()
    void conversation.send(inputEl.value)
  })

  stopBtn?.addEventListener("click", conversation.stopAndMark)
  closeBtn?.addEventListener("click", closePanel)
  talkBtn?.addEventListener("click", openCaseComposer)

  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && open && mobile.matches) {
      const focusableSelector =
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
      const focusable = Array.from(panelEl.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (item) => !item.hidden && item.getClientRects().length > 0
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      const challengeHost = document.querySelector<HTMLElement>("body > [data-myra-turnstile]")
      const challengeFirst = Array.from(
        challengeHost?.querySelectorAll<HTMLElement>(focusableSelector) ?? []
      ).find((item) => !item.hidden && item.getClientRects().length > 0)
      if (
        first &&
        last &&
        (e.shiftKey
          ? document.activeElement === first ||
            document.activeElement === challengeFirst ||
            document.activeElement === challengeHost
          : document.activeElement === last)
      ) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    if (e.key === "Escape" && open) {
      if (suggestions.isOpen()) {
        suggestions.hideSuggest()
        return
      }
      closePanel()
    }
  })

  document.addEventListener("focusin", (e) => {
    if (!open || !mobile.matches) return
    const target = e.target as Node | null
    if (
      target &&
      !panelEl.contains(target) &&
      !Array.from(document.querySelectorAll("[data-myra-turnstile]")).some((host) =>
        host.contains(target)
      )
    ) {
      inputEl.focus()
    }
  })

  startersEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-myra-send]")
    if (btn?.dataset.myraSend) void conversation.send(btn.dataset.myraSend)
  })

  return { open: openPanel }
}
