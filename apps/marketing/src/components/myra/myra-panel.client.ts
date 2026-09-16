/**
 * Myra panel client — lazy chunk. Imported dynamically by MyraPanel.astro on
 * first open only; nothing here (and no network call) runs before that.
 *
 * Rendering rules: only allowlisted components render; all model text goes
 * through sanitizeMarkdown/escapeHtml or textContent. No innerHTML with model
 * content anywhere in this module.
 */
import {
  createMyraClient,
  isManifestRoute,
  sanitizeLinkHref,
  sanitizeMarkdown,
  MYRA_COPY,
  MYRA_LIMITS,
  type MyraClient,
  type MyraClientError,
  type MyraComponent,
  type MyraStreamEvent,
} from "@lyrashield/myra"
import {
  myraApiBase,
  myraHeaders,
  getMyraToken,
  getMyraSessionId,
  clearMyraToken,
  ensureMyraSession,
  getTurnstileToken,
} from "./myra-session"

const apiBase = myraApiBase()

/** Route context is an allowlisted path identifier, never scraped DOM text. */
function routeContextFor(pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (isManifestRoute(path, "marketing")) return path
  const first = `/${path.split("/")[1] ?? ""}`
  return isManifestRoute(first, "marketing") ? first : undefined
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * The marketing worker's generated types merge a workerd Element (whose
 * `append` takes string|ReadableStream|Response) over the DOM's — the variadic
 * ParentNode.append signature is unreachable for typecheck. appendChild is
 * unambiguous; route every child insert through it.
 */
function add(parent: Node, ...kids: (Node | string)[]): void {
  for (const kid of kids) {
    parent.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
  }
}

function safeHref(raw: string | undefined, requireManifest = false): string | null {
  if (!raw) return null
  const href = sanitizeLinkHref(raw)
  if (!href) return null
  if (requireManifest && href.startsWith("/") && !isManifestRoute(href, "marketing")) {
    return null
  }
  return href
}

function appendLink(parent: HTMLElement, href: string, label: string, className: string) {
  const a = el("a", className, label)
  a.href = href
  if (!href.startsWith("/")) {
    a.target = "_blank"
    a.rel = "noopener noreferrer"
  }
  add(parent, a)
  return a
}

/** Render the sanitized inline segments of one line into a block element. */
function appendInlineSegments(parent: HTMLElement, text: string) {
  for (const seg of sanitizeMarkdown(text)) {
    if (seg.kind === "code") {
      add(parent, el("code", "myra-inline-code", seg.text))
    } else if (seg.kind === "link" && seg.href) {
      appendLink(parent, seg.href, seg.text, "myra-link")
    } else {
      add(parent, document.createTextNode(seg.text))
    }
  }
}

/**
 * Model markdown → safe DOM. Lines starting with "- "/"* " become list items,
 * ``` fences become <pre><code>, everything else is paragraphs. The renderer
 * owns all markup — the sanitizer only produced text/code/link segments.
 */
function renderMarkdownBody(container: HTMLElement, markdown: string) {
  container.textContent = ""
  let inFence = false
  let codeLines: string[] = []
  let list: HTMLUListElement | null = null
  let para: HTMLParagraphElement | null = null

  const flushPara = () => {
    para = null
  }
  const closeList = () => {
    list = null
  }
  const flushCode = () => {
    if (!codeLines.length) return
    const pre = el("pre", "myra-code")
    add(pre, el("code", "", codeLines.join("\n")))
    add(container, pre)
    codeLines = []
  }

  for (const rawLine of markdown.split("\n")) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith("```")) {
      if (inFence) flushCode()
      inFence = !inFence
      flushPara()
      closeList()
      continue
    }
    if (inFence) {
      codeLines.push(rawLine)
      continue
    }
    if (!trimmed) {
      flushPara()
      closeList()
      continue
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/) ?? trimmed.match(/^\d{1,2}[.)]\s+(.*)$/)
    if (bullet) {
      flushPara()
      if (!list) {
        list = el("ul", "myra-list")
        add(container, list)
      }
      const li = el("li")
      appendInlineSegments(li, bullet[1])
      add(list, li)
      continue
    }
    if (!para) {
      para = el("p", "myra-p")
      add(container, para)
    } else {
      add(para, document.createTextNode(" "))
    }
    appendInlineSegments(para, trimmed)
  }
  if (inFence) flushCode()
}

// ─── Panel runtime ──────────────────────────────────────────────────────────

interface ProposalRef {
  id: string
  title: string
  description: string
  confirmLabel: string
  expiresAt?: string
}

interface Turn {
  id: number
  root: HTMLElement
  answerEl: HTMLElement | null
  answerBuf: string
  completedAction: boolean
  stopped: boolean
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
    routeContext,
  })

  let open = false
  let bootstrapped = false
  let conversationId: string | undefined
  let lastTraceId: string | undefined
  let turnSeq = 0
  let currentTurn: Turn | null = null
  let streamAbort: AbortController | null = null
  let suggestAbort: AbortController | null = null
  let suggestTimer: number | undefined
  let suggestItems: { entryId: string; title: string; snippet: string; sourceUrl?: string }[] = []
  let suggestActive = -1
  let restoredFocus: HTMLElement | null = null

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

  function openPanel() {
    if (open) return
    open = true
    restoredFocus = (document.activeElement as HTMLElement) ?? launcherEl
    panelEl.hidden = false
    launcherEl.hidden = true
    launcherEl.setAttribute("aria-expanded", "true")
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
    stopStream()
    hideSuggest()
    panelEl.hidden = true
    launcherEl.hidden = false
    launcherEl.setAttribute("aria-expanded", "false")
    ;(restoredFocus ?? launcherEl).focus()
    announce("Myra panel closed.")
  }

  function stopStream() {
    if (!streamAbort) return
    streamAbort.abort()
    streamAbort = null
  }

  // ─── Turn rendering ────────────────────────────────────────────────────────

  function addTurn(userText: string): Turn {
    emptyEl?.setAttribute("hidden", "")
    const turn: Turn = {
      id: ++turnSeq,
      root: el("div", "myra-turn"),
      answerEl: null,
      answerBuf: "",
      completedAction: false,
      stopped: false,
    }
    const userBubble = el("div", "myra-msg myra-msg-user")
    add(userBubble, el("p", "myra-p", userText))
    const assistant = el("div", "myra-msg myra-msg-assistant")
    const answer = el("div", "myra-answer")
    add(assistant, answer)
    turn.answerEl = answer
    add(turn.root, userBubble, assistant)
    add(logEl, turn.root)
    return turn
  }

  function markStopped(turn: Turn) {
    turn.stopped = true
    if (turn.root.dataset.stopped) return
    turn.root.dataset.stopped = "1"
    const note = el(
      "p",
      "myra-note",
      turn.completedAction
        ? "Stopped. Actions that already completed were not undone."
        : "Stopped — nothing was executed."
    )
    add(turn.root, note)
  }

  function markError(turn: Turn, code?: string, recoveredDraft = false) {
    const note = el(
      "p",
      "myra-note myra-note-error",
      code === "PROPOSAL_EXPIRED"
        ? "That request expired — ask Myra to prepare it again."
        : recoveredDraft
          ? "Something went wrong before Myra replied. Your message is back in the composer."
          : "Something went wrong. Try again or talk to a person."
    )
    add(turn.root, note)
  }

  function refreshAnswer(turn: Turn) {
    if (turn.answerEl) renderMarkdownBody(turn.answerEl, turn.answerBuf)
  }

  // ─── Component renderers (allowlist only) ─────────────────────────────────

  function statusChip(status: string): HTMLElement {
    const cls =
      status === "pass" || status === "done" || status === "COMPLETED"
        ? "myra-chip myra-chip-pass"
        : status === "fail" || status === "blocked" || status === "FAILED"
          ? "myra-chip myra-chip-fail"
          : "myra-chip"
    return el("span", cls, status.toLowerCase().replace(/_/g, " "))
  }

  function proposalActions(card: HTMLElement, ref: ProposalRef) {
    card.dataset.proposalId = ref.id
    const row = el("div", "myra-card-actions")
    const confirm = el("button", "myra-btn myra-btn-primary", ref.confirmLabel || "Confirm")
    confirm.type = "button"
    const cancel = el("button", "myra-btn", "Cancel")
    cancel.type = "button"
    const state = el("p", "myra-note")
    state.hidden = true
    confirm.addEventListener("click", () => {
      confirm.disabled = true
      cancel.disabled = true
      state.hidden = false
      state.textContent = "Working…"
      client
        .confirmProposal(ref.id)
        .then((raw) => {
          const result =
            raw && typeof raw === "object" && "data" in raw
              ? (raw as { data: { status?: unknown } }).data
              : (raw as { status?: unknown })
          state.textContent = "Done."
          state.classList.add("myra-note-ok")
          card.dataset.proposalState = "confirmed"
          const status = result && "status" in result ? String(result.status) : ""
          if (status === "COMPLETED" && currentTurn) currentTurn.completedAction = true
          if (status) state.textContent = `Done — ${status.toLowerCase().replace(/_/g, " ")}.`
          announce("Action confirmed.")
        })
        .catch((err: MyraClientError | Error) => {
          confirm.disabled = false
          cancel.disabled = false
          const code = "code" in err ? err.code : ""
          if (code === "VERIFICATION_REQUIRED") {
            renderVerifyStep(card, ref, state)
          } else {
            state.textContent =
              code === "PROPOSAL_EXPIRED"
                ? "That request expired — ask Myra to prepare it again."
                : code === "PROPOSAL_PAYLOAD_CHANGED"
                  ? "The details changed — review the new summary before confirming."
                  : "The action could not be completed. Try again or ask for a person."
          }
          announce("Action could not be confirmed.")
        })
    })
    cancel.addEventListener("click", () => {
      confirm.disabled = true
      cancel.disabled = true
      client
        .cancelProposal(ref.id)
        .catch(() => {})
        .finally(() => {
          state.hidden = false
          state.textContent = "Canceled — nothing was executed."
          card.dataset.proposalState = "cancelled"
          announce("Action canceled.")
        })
    })
    add(row, confirm, cancel)
    add(card, row, state)
  }

  function renderVerifyStep(card: HTMLElement, ref: ProposalRef, state: HTMLElement) {
    state.textContent = "Confirm it's you — we'll email a short code."
    const row = el("div", "myra-verify")
    const email = el("input", "myra-field") as HTMLInputElement
    email.type = "email"
    email.placeholder = "you@example.com"
    email.setAttribute("aria-label", "Email for verification code")
    const send = el("button", "myra-btn", "Email code")
    send.type = "button"
    const code = el("input", "myra-field") as HTMLInputElement
    code.inputMode = "numeric"
    code.maxLength = 12
    code.placeholder = "Code"
    code.setAttribute("aria-label", "Verification code")
    code.hidden = true
    const verify = el("button", "myra-btn myra-btn-primary", "Verify & confirm")
    verify.type = "button"
    verify.hidden = true
    const sessionId = getMyraSessionId()
    send.addEventListener("click", () => {
      if (!email.value.includes("@")) {
        state.textContent = "Enter a valid email address."
        return
      }
      send.disabled = true
      getTurnstileToken()
        .then((turnstileToken) =>
          fetch(`${apiBase}/api/myra/identity/request`, {
            method: "POST",
            credentials: "include",
            headers: myraHeaders(),
            body: JSON.stringify({
              email: email.value.trim(),
              purpose: "support_case",
              ...(sessionId ? { publicSessionId: sessionId } : {}),
              ...(turnstileToken ? { turnstileToken } : {}),
            }),
          })
        )
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status))
          state.textContent = "Check your email for the code."
          code.hidden = false
          verify.hidden = false
          code.focus()
        })
        .catch(() => {
          send.disabled = false
          state.textContent = "We could not send a code. Try again."
        })
    })
    verify.addEventListener("click", () => {
      verify.disabled = true
      fetch(`${apiBase}/api/myra/identity/confirm`, {
        method: "POST",
        credentials: "include",
        headers: myraHeaders(),
        body: JSON.stringify({
          email: email.value.trim(),
          purpose: "support_case",
          code: code.value.trim(),
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status))
          state.textContent = "Verified — confirming now."
          return client.confirmProposal(ref.id).then(() => {
            state.textContent = "Done."
            card.dataset.proposalState = "confirmed"
            if (currentTurn) currentTurn.completedAction = true
          })
        })
        .catch(() => {
          verify.disabled = false
          state.textContent = "That code did not work. Try again."
        })
    })
    add(row, email, send, code, verify)
    add(card, row)
  }

  function renderComponent(c: MyraComponent, host: HTMLElement) {
    switch (c.type) {
      case "answer": {
        const div = el("div", "myra-answer")
        renderMarkdownBody(div, c.markdown)
        add(host, div)
        return
      }
      case "source_link": {
        const href = safeHref(c.url)
        if (!href) return
        const p = el("p", "myra-srclink")
        appendLink(p, href, c.label, "myra-link")
        add(host, p)
        return
      }
      case "plan_comparison": {
        const card = el("section", "myra-card")
        add(card, el("p", "myra-card-title", "Plan comparison"))
        add(card, el("p", "myra-meta", `Checked ${c.checkedAt}`))
        const table = el("table", "myra-table")
        const head = el("thead")
        const hr = el("tr")
        for (const h of ["Plan", "Price", "Minutes", "Availability"]) {
          add(hr, el("th", "", h))
        }
        add(head, hr)
        add(table, head)
        const body = el("tbody")
        for (const p of c.plans) {
          const tr = el("tr")
          add(tr, el("td", "", p.name))
          const price =
            p.monthlyUsd != null
              ? `$${p.monthlyUsd}/mo`
              : p.monthlyInr != null
                ? `₹${p.monthlyInr}/mo`
                : "Contact us"
          add(tr, el("td", "", price))
          add(tr, el("td", "", p.agentMinutes != null ? String(p.agentMinutes) : "—"))
          const td = el("td")
          add(td, statusChip(p.availability))
          add(tr, td)
          add(body, tr)
        }
        add(table, body)
        add(card, table)
        if (c.note) add(card, el("p", "myra-note", c.note))
        const cta = c.plans.find((p) => p.ctaRoute)?.ctaRoute
        const ctaHref = safeHref(cta, true)
        if (ctaHref) appendLink(card, ctaHref, "See pricing", "myra-btn myra-btn-link")
        add(host, card)
        return
      }
      case "diagnostic_status": {
        const card = el("section", "myra-card")
        add(card, el("p", "myra-card-title", c.title))
        add(card, el("p", "myra-meta", `Checked ${c.checkedAt}`))
        const ul = el("ul", "myra-checks")
        for (const check of c.checks) {
          const li = el("li")
          add(li, statusChip(check.status))
          add(li, el("span", "myra-check-label", check.label))
          if (check.detail) add(li, el("span", "myra-note", ` — ${check.detail}`))
          const href = safeHref(check.ctaRoute, true)
          if (href) appendLink(li, href, "Open", "myra-link")
          add(ul, li)
        }
        add(card, ul)
        add(host, card)
        return
      }
      case "task_steps": {
        const card = el("section", "myra-card")
        const ol = el("ol", "myra-steps")
        for (const step of c.steps) {
          const li = el("li")
          add(li, statusChip(step.status))
          add(li, el("span", "myra-check-label", step.title))
          if (step.detail) add(li, el("p", "myra-note", step.detail))
          const href = safeHref(step.ctaRoute, true)
          if (href) appendLink(li, href, "Open", "myra-link")
          add(ol, li)
        }
        add(card, ol)
        add(host, card)
        return
      }
      case "support_case_preview": {
        const card = el("section", "myra-card myra-card-confirm")
        add(card, el("p", "myra-card-title", MYRA_COPY.caseDraft))
        add(card, el("p", "myra-case-subject", c.subject))
        const summary = el("p", "myra-p myra-pre", c.summary)
        add(card, summary)
        add(card, el("p", "myra-meta", `Replies go to ${c.replyDestination}`))
        const flags: string[] = []
        if (c.includeDiagnostics) flags.push("diagnostic excerpt")
        if (c.includeTranscriptExcerpt) flags.push("transcript excerpt")
        add(
          card,
          el(
            "p",
            "myra-meta",
            flags.length
              ? `Includes ${flags.join(" and ")}.`
              : "No diagnostics or transcript attached."
          )
        )
        add(card, el("p", "myra-meta", `Expires ${c.expiresAt}`))
        proposalActions(card, {
          id: c.proposalId,
          title: c.subject,
          description: c.summary,
          confirmLabel: "Send to support",
          expiresAt: c.expiresAt,
        })
        add(host, card)
        return
      }
      case "slot_picker": {
        const card = el("section", "myra-card")
        add(card, el("p", "myra-card-title", "Pick a time"))
        add(card, el("p", "myra-meta", `Times shown in ${c.displayTimezone}`))
        const grid = el("div", "myra-slots")
        for (const slot of c.slots) {
          const start = new Date(slot.startsAt)
          const label = Number.isNaN(start.valueOf())
            ? slot.startsAt
            : new Intl.DateTimeFormat(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: c.displayTimezone,
              }).format(start)
          const btn = el("button", "myra-btn", label)
          btn.type = "button"
          btn.addEventListener("click", () => {
            void send(`Book the demo slot that starts at ${slot.startsAt}`)
          })
          add(grid, btn)
        }
        add(card, grid)
        add(host, card)
        return
      }
      case "action_confirmation": {
        const card = el("section", "myra-card myra-card-confirm")
        add(card, el("p", "myra-card-title", c.title))
        add(card, el("p", "myra-p", c.description))
        add(card, el("p", "myra-meta", `Expires ${c.expiresAt}`))
        proposalActions(card, {
          id: c.proposalId,
          title: c.title,
          description: c.description,
          confirmLabel: c.confirmLabel,
          expiresAt: c.expiresAt,
        })
        add(host, card)
        return
      }
      case "action_result": {
        const card = el("section", "myra-card")
        const head = el("div", "myra-result-head")
        add(head, statusChip(c.status))
        add(head, el("span", "myra-check-label", c.title))
        add(card, head)
        if (c.detail) add(card, el("p", "myra-p", c.detail))
        if (c.reference) add(card, el("p", "myra-meta", `Reference ${c.reference}`))
        if (c.status === "COMPLETED" && currentTurn) currentTurn.completedAction = true
        add(host, card)
        return
      }
      case "guided_flow": {
        const card = el("section", "myra-card")
        const head = el("div", "myra-result-head")
        add(head, el("span", "myra-card-title", c.flowTitle))
        add(head, statusChip(c.status))
        add(card, head)
        const ol = el("ol", "myra-steps")
        c.steps.forEach((step, idx) => {
          const li = el("li")
          add(li, statusChip(step.status))
          add(li, el("span", "myra-check-label", `${idx + 1}. ${step.title}`))
          add(ol, li)
        })
        add(card, ol)
        add(host, card)
        return
      }
      case "instant_suggestions": {
        const card = el("section", "myra-card")
        add(card, el("p", "myra-card-title", "Instant answers"))
        const ul = el("ul", "myra-checks")
        for (const s of c.suggestions) {
          const li = el("li")
          add(li, el("span", "myra-check-label", s.title))
          add(li, el("p", "myra-note", s.snippet))
          const href = safeHref(s.sourceUrl)
          if (href) appendLink(li, href, "Source", "myra-link")
          add(ul, li)
        }
        add(card, ul)
        add(host, card)
        return
      }
      case "memory_card": {
        const card = el("section", "myra-card")
        add(card, el("p", "myra-card-title", "What Myra remembers"))
        if (!c.entries.length) {
          add(card, el("p", "myra-note", "Nothing stored for this session."))
        } else {
          const ul = el("ul", "myra-checks")
          for (const entry of c.entries) {
            const li = el("li")
            add(li, el("span", "myra-check-label", entry.label))
            add(ul, li)
          }
          add(card, ul)
        }
        add(host, card)
        return
      }
      case "capability_line": {
        const details = el("details", "myra-capability")
        add(details, el("summary", "", "What Myra checked"))
        const ul = el("ul", "myra-checks")
        for (const item of c.canSee) {
          const li = el("li")
          add(li, el("span", "myra-check-label", item))
          add(ul, li)
        }
        for (const item of c.cannotSee) {
          const li = el("li")
          add(li, el("span", "myra-note", `Not ${item}`))
          add(ul, li)
        }
        add(details, ul)
        add(host, details)
        return
      }
      case "trace_ref": {
        add(host, el("p", "myra-trace", `trace ${c.traceId}`))
        lastTraceId = c.traceId
        return
      }
      default:
        return
    }
  }

  // ─── Streaming ────────────────────────────────────────────────────────────

  function handleEvent(ev: MyraStreamEvent, turn: Turn) {
    switch (ev.type) {
      case "ready":
        conversationId = ev.conversationId
        lastTraceId = ev.traceId
        return
      case "activity":
        setActivity(ev.label)
        return
      case "token":
        turn.answerBuf += ev.text
        if (turn.answerEl && nearBottom()) {
          refreshAnswer(turn)
          scrollToBottom()
        } else {
          refreshAnswer(turn)
        }
        return
      case "component": {
        const host = turn.answerEl?.parentElement ?? turn.root
        renderComponent(ev.component, host)
        scrollToBottom()
        return
      }
      case "proposal": {
        // The loop emits a structured confirm card (action_confirmation /
        // support_case_preview) AND this event for the same proposal — skip
        // the generic card when the rich card already carries the actions.
        if (turn.root.querySelector(`[data-proposal-id="${CSS.escape(ev.proposal.id)}"]`)) {
          announce("Myra prepared an action for you to confirm.")
          return
        }
        const card = el("section", "myra-card myra-card-confirm")
        add(card, el("p", "myra-card-title", ev.proposal.title))
        add(card, el("p", "myra-p", ev.proposal.description))
        const previewEntries = Object.entries(ev.proposal.payloadPreview ?? {}).slice(0, 8)
        if (previewEntries.length) {
          const dl = el("dl", "myra-kv")
          for (const [k, v] of previewEntries) {
            add(dl, el("dt", "", k))
            add(dl, el("dd", "", typeof v === "string" ? v : JSON.stringify(v)))
          }
          add(card, dl)
        }
        add(card, el("p", "myra-meta", `Expires ${ev.proposal.expiresAt}`))
        proposalActions(card, {
          id: ev.proposal.id,
          title: ev.proposal.title,
          description: ev.proposal.description,
          confirmLabel: "Confirm",
          expiresAt: ev.proposal.expiresAt,
        })
        add(turn.answerEl?.parentElement ?? turn.root, card)
        scrollToBottom()
        announce("Myra prepared an action for you to confirm.")
        return
      }
      case "operation": {
        const selector = `[data-proposal-id="${CSS.escape(ev.operationId)}"]`
        const card = turn.root.querySelector<HTMLElement>(selector)
        if (card) {
          let state = card.querySelector<HTMLElement>(".myra-note")
          if (!state) {
            state = el("p", "myra-note")
            add(card, state)
          }
          state.hidden = false
          state.textContent = `Status: ${ev.status.toLowerCase().replace(/_/g, " ")}`
          if (ev.status === "COMPLETED") turn.completedAction = true
        }
        return
      }
      case "done":
        setActivity(null)
        if (lastTraceId) {
          const host = turn.answerEl?.parentElement ?? turn.root
          add(host, el("p", "myra-trace", `trace ${lastTraceId}`))
        }
        announce("Myra finished responding.")
        return
      case "error":
        setActivity(null)
        markError(turn, ev.error.code)
        announce(`Error: ${ev.error.message}`)
        return
      default:
        return
    }
  }

  async function send(text: string) {
    const trimmed = text.trim().slice(0, MYRA_LIMITS.messageMaxChars)
    if (!trimmed) return
    if (streamAbort) {
      // A turn is in flight — keep the draft, tell the user why nothing sent.
      announce("Myra is still answering — wait a moment or press Stop.")
      inputEl.value = trimmed
      return
    }
    hideSuggest()
    inputEl.value = ""
    const turn = addTurn(trimmed)
    currentTurn = turn
    scrollToBottom()
    setStreaming(true)
    setActivity("Working on it…")
    announce("Message sent.")
    streamAbort = new AbortController()

    let attemptedReauth = false
    let received = false
    for (;;) {
      try {
        await bootstrapSession()
        for await (const ev of client.sendMessage({
          text: trimmed,
          conversationId,
          signal: streamAbort.signal,
        })) {
          received = true
          handleEvent(ev, turn)
        }
        break
      } catch (err) {
        if (streamAbort.signal.aborted || (err as Error).name === "AbortError") break
        const code = (err as MyraClientError).code
        if (code === "UNAUTHORIZED" && !attemptedReauth) {
          attemptedReauth = true
          clearMyraToken()
          continue
        }
        setActivity(null)
        const recoveredDraft = !received && !inputEl.value
        if (recoveredDraft) {
          // Send never reached the server — keep the draft rather than lose it.
          inputEl.value = trimmed
        }
        markError(turn, code, recoveredDraft)
        announce("Message failed.")
        break
      }
    }

    streamAbort = null
    setStreaming(false)
    setActivity(null)
    if (turn.stopped) markStopped(turn)
  }

  function stopAndMark() {
    if (!streamAbort) return
    if (currentTurn) currentTurn.stopped = true
    stopStream()
    setStreaming(false)
    setActivity(null)
    if (currentTurn) markStopped(currentTurn)
    announce("Stopped — generation canceled. Anything already confirmed was not undone.")
  }

  // ─── Suggestions (retrieval only, debounced) ──────────────────────────────

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
    // Instant answers render locally — no model call, no cost.
    const turn: Turn = {
      id: ++turnSeq,
      root: el("div", "myra-turn"),
      answerEl: null,
      answerBuf: "",
      completedAction: false,
      stopped: false,
    }
    emptyEl?.setAttribute("hidden", "")
    const userBubble = el("div", "myra-msg myra-msg-user")
    add(userBubble, el("p", "myra-p", s.title))
    const assistant = el("div", "myra-msg myra-msg-assistant")
    const body = el("div", "myra-answer")
    add(body, el("p", "myra-p", s.snippet))
    const href = safeHref(s.sourceUrl)
    if (href) appendLink(body, href, "Source", "myra-link")
    add(assistant, body)
    add(turn.root, userBubble, assistant)
    add(logEl, turn.root)
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
              ? (res as { data: { suggestions?: typeof suggestItems } }).data
              : (res as { suggestions?: typeof suggestItems })
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
      formEl.requestSubmit()
    }
  })

  // ─── Case composer ("Talk to a person") ───────────────────────────────────

  function openCaseComposer() {
    if (document.getElementById("myra-case-form")) {
      document.getElementById("myra-case-form")?.scrollIntoView({ block: "nearest" })
      return
    }
    emptyEl?.setAttribute("hidden", "")
    const card = el("section", "myra-card myra-case-form")
    card.id = "myra-case-form"
    add(card, el("p", "myra-card-title", "Talk to a person"))
    add(
      card,
      el(
        "p",
        "myra-note",
        "Tell us what happened. Myra will prepare a case summary for you to review before anything is sent."
      )
    )
    const subject = el("input", "myra-field") as HTMLInputElement
    subject.maxLength = 160
    subject.placeholder = "Subject"
    subject.setAttribute("aria-label", "Case subject")
    const summary = el("textarea", "myra-field") as HTMLTextAreaElement
    summary.rows = 4
    summary.maxLength = 4000
    summary.placeholder = "What happened? What were you trying to do?"
    summary.setAttribute("aria-label", "Case details")
    const email = el("input", "myra-field") as HTMLInputElement
    email.type = "email"
    email.maxLength = 320
    email.placeholder = "Email for replies"
    email.setAttribute("aria-label", "Email for replies")
    const diagLabel = el("label", "myra-check")
    const diag = el("input") as HTMLInputElement
    diag.type = "checkbox"
    add(diagLabel, diag, document.createTextNode(" Include a diagnostic excerpt"))
    const transcriptLabel = el("label", "myra-check")
    const transcript = el("input") as HTMLInputElement
    transcript.type = "checkbox"
    add(transcriptLabel, transcript, document.createTextNode(" Include a transcript excerpt"))
    const state = el("p", "myra-note")
    const row = el("div", "myra-card-actions")
    const submit = el("button", "myra-btn myra-btn-primary", "Continue")
    submit.type = "button"
    const dismiss = el("button", "myra-btn", "Close")
    dismiss.type = "button"
    dismiss.addEventListener("click", () => card.remove())

    // Anonymous reply destinations must be verified before the case can be
    // drafted — the confirm step re-checks it, so verify here once.
    const verifyRow = el("div", "myra-verify")
    verifyRow.hidden = true
    const code = el("input", "myra-field") as HTMLInputElement
    code.inputMode = "numeric"
    code.maxLength = 12
    code.placeholder = "Code"
    code.setAttribute("aria-label", "Verification code")
    const verify = el("button", "myra-btn myra-btn-primary", "Verify")
    verify.type = "button"
    add(verifyRow, code, verify)

    const sessionId = getMyraSessionId()

    function sendCaseMessage() {
      const subjectText = subject.value.trim()
      const summaryText = summary.value.trim()
      const parts = [
        "Please prepare a support case for me.",
        `Subject: ${subjectText}`,
        `Details: ${summaryText}`,
        `Reply email: ${email.value.trim()}`,
        `Include diagnostic excerpt: ${diag.checked ? "yes" : "no"}`,
        `Include transcript excerpt: ${transcript.checked ? "yes" : "no"}`,
      ]
      if (lastTraceId) parts.push(`Attach trace: ${lastTraceId}`)
      card.remove()
      void send(parts.join("\n"))
    }

    verify.addEventListener("click", () => {
      const codeText = code.value.trim()
      if (codeText.length < 4) {
        state.textContent = "Enter the code from the email."
        return
      }
      verify.disabled = true
      fetch(`${apiBase}/api/myra/identity/confirm`, {
        method: "POST",
        credentials: "include",
        headers: myraHeaders(),
        body: JSON.stringify({
          email: email.value.trim(),
          purpose: "support_case",
          code: codeText,
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status))
          state.textContent = "Verified — preparing your case draft."
          sendCaseMessage()
        })
        .catch(() => {
          verify.disabled = false
          state.textContent = "That code did not work. Try again."
        })
    })

    submit.addEventListener("click", () => {
      const subjectText = subject.value.trim()
      const summaryText = summary.value.trim()
      const emailText = email.value.trim()
      if (subjectText.length < 4 || summaryText.length < 10) {
        announce("Add a subject and a few words about what happened.")
        summary.focus()
        return
      }
      if (!emailText.includes("@")) {
        state.textContent = "Enter the email replies should go to."
        email.focus()
        return
      }
      submit.disabled = true
      state.textContent = "Sending a verification code…"
      getTurnstileToken()
        .then((turnstileToken) =>
          fetch(`${apiBase}/api/myra/identity/request`, {
            method: "POST",
            credentials: "include",
            headers: myraHeaders(),
            body: JSON.stringify({
              email: emailText,
              purpose: "support_case",
              ...(sessionId ? { publicSessionId: sessionId } : {}),
              ...(turnstileToken ? { turnstileToken } : {}),
            }),
          })
        )
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status))
          state.textContent = `We emailed a short code to ${emailText}.`
          verifyRow.hidden = false
          submit.hidden = true
          email.disabled = true
          code.focus()
        })
        .catch(() => {
          submit.disabled = false
          state.textContent = "We could not send a code. Try again in a minute."
        })
    })
    add(row, submit, dismiss)
    add(card, subject, summary, email, diagLabel, transcriptLabel, verifyRow, row, state)
    add(logEl, card)
    scrollToBottom()
    subject.focus()
    announce("Case form opened.")
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  formEl.addEventListener("submit", (e) => {
    e.preventDefault()
    void send(inputEl.value)
  })

  stopBtn?.addEventListener("click", stopAndMark)
  closeBtn?.addEventListener("click", closePanel)
  talkBtn?.addEventListener("click", openCaseComposer)

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      if (!suggestEl?.hidden) {
        hideSuggest()
        return
      }
      closePanel()
    }
  })

  startersEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-myra-send]")
    if (btn?.dataset.myraSend) void send(btn.dataset.myraSend)
  })

  return { open: openPanel }
}
