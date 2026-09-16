import type { MyraClient } from "@lyrashield/myra"
import { add, appendMyraLink, el, safeMyraHref } from "./myra-dom-renderer"

interface Suggestion {
  entryId: string
  title: string
  snippet: string
  sourceUrl?: string
}

export function initMyraSuggestions(options: {
  client: MyraClient
  inputEl: HTMLTextAreaElement
  suggestEl: HTMLElement | null
  logEl: HTMLElement
  emptyEl: HTMLElement | null
  scrollToBottom: () => void
  announce: (text: string) => void
  onSubmit: () => void
}) {
  const { client, inputEl, suggestEl, logEl, emptyEl, scrollToBottom, announce, onSubmit } = options

  let suggestAbort: AbortController | null = null
  let suggestTimer: number | undefined
  let suggestItems: Suggestion[] = []
  let suggestActive = -1

  function hideSuggest() {
    suggestItems = []
    suggestActive = -1
    if (suggestEl) {
      suggestEl.hidden = true
      suggestEl.textContent = ""
    }
    inputEl.removeAttribute("aria-activedescendant")
  }

  function showSuggest() {
    if (!suggestEl) return
    suggestEl.textContent = ""
    suggestItems.forEach((s, i) => {
      const opt = el("li", "myra-suggest-item")
      opt.id = `myra-suggest-${i}`
      opt.setAttribute("role", "option")
      opt.setAttribute("aria-selected", i === suggestActive ? "true" : "false")
      add(opt, el("span", "myra-suggest-title", s.title))
      add(opt, el("span", "myra-suggest-snippet", s.snippet))
      opt.addEventListener("pointerdown", (e) => {
        e.preventDefault()
        pickSuggestion(i)
      })
      add(suggestEl, opt)
    })
    suggestEl.hidden = false
  }

  function pickSuggestion(i: number) {
    const s = suggestItems[i]
    hideSuggest()
    if (!s) return
    emptyEl?.setAttribute("hidden", "")
    const root = el("div", "myra-turn")
    const userBubble = el("div", "myra-msg myra-msg-user")
    add(userBubble, el("p", "myra-p", s.title))
    const assistant = el("div", "myra-msg myra-msg-assistant")
    const body = el("div", "myra-answer")
    add(body, el("p", "myra-p", s.snippet))
    const href = safeMyraHref(s.sourceUrl)
    if (href) appendMyraLink(body, href, "Source", "myra-link")
    add(assistant, body)
    add(root, userBubble, assistant)
    add(logEl, root)
    scrollToBottom()
    announce("Instant answer shown.")
  }

  inputEl.addEventListener("input", () => {
    window.clearTimeout(suggestTimer)
    const text = inputEl.value.trim()
    if (text.length < 2) {
      hideSuggest()
      return
    }
    suggestTimer = window.setTimeout(() => {
      suggestAbort?.abort()
      suggestAbort = new AbortController()
      client
        .suggest(text.slice(0, 300), suggestAbort.signal)
        .then((res) => {
          const payload =
            res && typeof res === "object" && "data" in res
              ? (res as { data: { suggestions?: Suggestion[] } }).data
              : (res as { suggestions?: Suggestion[] })
          suggestItems = (payload.suggestions ?? []).slice(0, 3)
          suggestActive = -1
          if (suggestItems.length) showSuggest()
          else hideSuggest()
        })
        .catch(() => {
          /* suggestion failure is silent — free text still works */
        })
    }, 150)
  })

  inputEl.addEventListener("keydown", (e) => {
    if (!suggestEl?.hidden && suggestItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        suggestActive =
          (suggestActive + (e.key === "ArrowDown" ? 1 : -1) + suggestItems.length) %
          suggestItems.length
        showSuggest()
        inputEl.setAttribute("aria-activedescendant", `myra-suggest-${suggestActive}`)
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && suggestActive >= 0) {
        e.preventDefault()
        pickSuggestion(suggestActive)
        return
      }
      if (e.key === "Escape") {
        hideSuggest()
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  })

  return {
    hideSuggest,
    isOpen: () => !suggestEl?.hidden,
  }
}
