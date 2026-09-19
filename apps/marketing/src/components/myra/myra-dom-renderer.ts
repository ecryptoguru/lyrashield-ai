import {
  isManifestRoute,
  parseMyraMarkdownBlocks,
  sanitizeLinkHref,
  sanitizeMarkdown,
  MYRA_COPY,
  type BookingRequest,
  type MyraClient,
  type MyraClientError,
  type MyraComponent,
} from "@lyrashield/myra"
import { getMyraSessionId, getTurnstileToken, myraHeaders } from "./myra-session"

export interface MyraDomRendererContext {
  client: MyraClient
  apiBase: string
  announce: (text: string) => void
  /** Chat turn; `bookingRequest` carries a structured slot-picker submission. */
  send: (text: string, bookingRequest?: BookingRequest) => void
  markActionCompleted: () => void
  setLastTraceId: (traceId: string) => void
}

interface ProposalRef {
  id: string
  title: string
  description: string
  confirmLabel: string
  expiresAt?: string
}

export function el<K extends keyof HTMLElementTagNameMap>(
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
export function add(parent: Node, ...kids: (Node | string)[]): void {
  for (const kid of kids) {
    parent.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
  }
}

export function safeMyraHref(raw: string | undefined, requireManifest = false): string | null {
  if (!raw) return null
  const href = sanitizeLinkHref(raw)
  if (!href) return null
  if (requireManifest && href.startsWith("/") && !isManifestRoute(href, "marketing")) {
    return null
  }
  return href
}

export function appendMyraLink(
  parent: HTMLElement,
  href: string,
  label: string,
  className: string
) {
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
      appendMyraLink(parent, seg.href, seg.text, "myra-link")
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
export function renderMyraMarkdownBody(container: HTMLElement, markdown: string): void {
  container.textContent = ""
  for (const block of parseMyraMarkdownBlocks(markdown)) {
    if (block.type === "code") {
      const pre = el("pre", "myra-code")
      add(pre, el("code", "", block.text))
      add(container, pre)
    } else if (block.type === "list") {
      const list = el("ul", "myra-list")
      for (const item of block.items) {
        const li = el("li")
        appendInlineSegments(li, item)
        add(list, li)
      }
      add(container, list)
    } else {
      const para = el("p", "myra-p")
      for (const [i, line] of block.lines.entries()) {
        if (i) add(para, document.createTextNode(" "))
        appendInlineSegments(para, line)
      }
      add(container, para)
    }
  }
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

export function renderMyraProposalActions(
  card: HTMLElement,
  proposal: ProposalRef,
  context: MyraDomRendererContext
): void {
  card.dataset.proposalId = proposal.id
  const row = el("div", "myra-card-actions")
  const confirm = el("button", "myra-btn myra-btn-primary", proposal.confirmLabel || "Confirm")
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
    context.client
      .confirmProposal(proposal.id)
      .then((raw) => {
        const result =
          raw && typeof raw === "object" && "data" in raw
            ? (raw as { data: { status?: unknown } }).data
            : (raw as { status?: unknown })
        state.textContent = "Done."
        state.classList.add("myra-note-ok")
        card.dataset.proposalState = "confirmed"
        const status = result && "status" in result ? String(result.status) : ""
        if (status === "COMPLETED") context.markActionCompleted()
        if (status) state.textContent = `Done — ${status.toLowerCase().replace(/_/g, " ")}.`
        context.announce("Action confirmed.")
      })
      .catch((err: MyraClientError | Error) => {
        confirm.disabled = false
        cancel.disabled = false
        const code = "code" in err ? err.code : ""
        if (code === "VERIFICATION_REQUIRED") {
          renderVerifyStep(card, proposal, state, context)
        } else {
          state.textContent =
            code === "PROPOSAL_EXPIRED"
              ? "That request expired — ask Myra to prepare it again."
              : code === "PROPOSAL_PAYLOAD_CHANGED"
                ? "The details changed — review the new summary before confirming."
                : "The action could not be completed. Try again or ask for a person."
        }
        context.announce("Action could not be confirmed.")
      })
  })
  cancel.addEventListener("click", () => {
    confirm.disabled = true
    cancel.disabled = true
    context.client
      .cancelProposal(proposal.id)
      .catch(() => {})
      .finally(() => {
        state.hidden = false
        state.textContent = "Canceled — nothing was executed."
        card.dataset.proposalState = "cancelled"
        context.announce("Action canceled.")
      })
  })
  add(row, confirm, cancel)
  add(card, row, state)
}

function renderVerifyStep(
  card: HTMLElement,
  proposal: ProposalRef,
  state: HTMLElement,
  context: MyraDomRendererContext
) {
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
        fetch(`${context.apiBase}/api/myra/identity/request`, {
          method: "POST",
          credentials: "omit",
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
    fetch(`${context.apiBase}/api/myra/identity/confirm`, {
      method: "POST",
      credentials: "omit",
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
        return context.client.confirmProposal(proposal.id).then(() => {
          state.textContent = "Done."
          card.dataset.proposalState = "confirmed"
          context.markActionCompleted()
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

/**
 * Inline attendee step after a marketing slot pick. Anonymous attendees type
 * their own name/email; the server-side verifyAttendee gate then routes them
 * through the existing demo_booking email verification when needed.
 */
function renderSlotAttendeeStep(
  card: HTMLElement,
  grid: HTMLElement,
  slot: { id: string; startsAt: string; endsAt: string },
  displayTimezone: string,
  context: MyraDomRendererContext
): void {
  grid.hidden = true
  const form = el("div", "myra-attendee")
  const start = new Date(slot.startsAt)
  const label = Number.isNaN(start.valueOf())
    ? slot.startsAt
    : new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: displayTimezone,
      }).format(start)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  add(form, el("p", "myra-card-title", "Your details"))
  add(form, el("p", "myra-meta", `${label} · we'll send the invite in your timezone (${timezone})`))
  const nameInput = el("input", "myra-input") as HTMLInputElement
  nameInput.type = "text"
  nameInput.setAttribute("aria-label", "Your name")
  nameInput.setAttribute("autocomplete", "name")
  nameInput.setAttribute("placeholder", "Your name")
  const emailInput = el("input", "myra-input") as HTMLInputElement
  emailInput.type = "email"
  emailInput.setAttribute("aria-label", "Your email")
  emailInput.setAttribute("autocomplete", "email")
  emailInput.setAttribute("placeholder", "Your email")
  const error = el("p", "myra-note myra-attendee-error")
  const actions = el("div", "myra-attendee-actions")
  const continueBtn = el("button", "myra-btn myra-btn-primary", "Continue")
  continueBtn.type = "button"
  continueBtn.addEventListener("click", () => {
    const name = nameInput.value.trim()
    const email = emailInput.value.trim()
    if (!name || !email) {
      error.textContent = "Add your name and email to continue."
      return
    }
    context.send(`Book the demo slot that starts at ${slot.startsAt}`, {
      slotStart: slot.startsAt,
      timezone,
      name,
      email,
    })
  })
  const backBtn = el("button", "myra-btn myra-btn-ghost", "Back")
  backBtn.type = "button"
  backBtn.addEventListener("click", () => {
    form.remove()
    grid.hidden = false
  })
  add(form, nameInput, emailInput, error, actions)
  add(actions, continueBtn, backBtn)
  add(card, form)
  nameInput.focus()
}

export function renderMyraComponent(
  component: MyraComponent,
  host: HTMLElement,
  context: MyraDomRendererContext
): void {
  switch (component.type) {
    case "answer": {
      const div = el("div", "myra-answer")
      renderMyraMarkdownBody(div, component.markdown)
      add(host, div)
      return
    }
    case "source_link": {
      const href = safeMyraHref(component.url)
      if (!href) return
      const p = el("p", "myra-srclink")
      appendMyraLink(p, href, component.label, "myra-link")
      add(host, p)
      return
    }
    case "plan_comparison": {
      const card = el("section", "myra-card")
      add(card, el("p", "myra-card-title", "Plan comparison"))
      add(card, el("p", "myra-meta", `Checked ${component.checkedAt}`))
      const table = el("table", "myra-table")
      const head = el("thead")
      const hr = el("tr")
      for (const h of ["Plan", "Price", "Minutes", "Availability"]) {
        add(hr, el("th", "", h))
      }
      add(head, hr)
      add(table, head)
      const body = el("tbody")
      for (const p of component.plans) {
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
      if (component.note) add(card, el("p", "myra-note", component.note))
      const cta = component.plans.find((p) => p.ctaRoute)?.ctaRoute
      const ctaHref = safeMyraHref(cta, true)
      if (ctaHref) appendMyraLink(card, ctaHref, "See pricing", "myra-btn myra-btn-link")
      add(host, card)
      return
    }
    case "diagnostic_status": {
      const card = el("section", "myra-card")
      add(card, el("p", "myra-card-title", component.title))
      add(card, el("p", "myra-meta", `Checked ${component.checkedAt}`))
      const ul = el("ul", "myra-checks")
      for (const check of component.checks) {
        const li = el("li")
        add(li, statusChip(check.status))
        add(li, el("span", "myra-check-label", check.label))
        if (check.detail) add(li, el("span", "myra-note", ` — ${check.detail}`))
        const href = safeMyraHref(check.ctaRoute, true)
        if (href) appendMyraLink(li, href, "Open", "myra-link")
        add(ul, li)
      }
      add(card, ul)
      add(host, card)
      return
    }
    case "task_steps": {
      const card = el("section", "myra-card")
      const ol = el("ol", "myra-steps")
      for (const step of component.steps) {
        const li = el("li")
        add(li, statusChip(step.status))
        add(li, el("span", "myra-check-label", step.title))
        if (step.detail) add(li, el("p", "myra-note", step.detail))
        const href = safeMyraHref(step.ctaRoute, true)
        if (href) appendMyraLink(li, href, "Open", "myra-link")
        add(ol, li)
      }
      add(card, ol)
      add(host, card)
      return
    }
    case "support_case_preview": {
      const card = el("section", "myra-card myra-card-confirm")
      add(card, el("p", "myra-card-title", MYRA_COPY.caseDraft))
      add(card, el("p", "myra-case-subject", component.subject))
      const summary = el("p", "myra-p myra-pre", component.summary)
      add(card, summary)
      add(card, el("p", "myra-meta", `Replies go to ${component.replyDestination}`))
      const flags: string[] = []
      if (component.includeDiagnostics) flags.push("diagnostic excerpt")
      if (component.includeTranscriptExcerpt) flags.push("transcript excerpt")
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
      add(card, el("p", "myra-meta", `Expires ${component.expiresAt}`))
      renderMyraProposalActions(
        card,
        {
          id: component.proposalId,
          title: component.subject,
          description: component.summary,
          confirmLabel: "Send to support",
          expiresAt: component.expiresAt,
        },
        context
      )
      add(host, card)
      return
    }
    case "slot_picker": {
      const card = el("section", "myra-card")
      add(card, el("p", "myra-card-title", "Pick a time"))
      add(card, el("p", "myra-meta", `Times shown in ${component.displayTimezone}`))
      const grid = el("div", "myra-slots")
      for (const slot of component.slots) {
        const start = new Date(slot.startsAt)
        const label = Number.isNaN(start.valueOf())
          ? slot.startsAt
          : new Intl.DateTimeFormat(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: component.displayTimezone,
            }).format(start)
        const btn = el("button", "myra-btn", label)
        btn.type = "button"
        // The pick alone never sends a chat turn — the attendee step below
        // collects name/email and submits a structured bookingRequest so the
        // server drives book_demo without parsing free text (item 1.5).
        btn.addEventListener("click", () => {
          renderSlotAttendeeStep(card, grid, slot, component.displayTimezone, context)
        })
        add(grid, btn)
      }
      add(card, grid)
      add(host, card)
      return
    }
    case "action_confirmation": {
      const card = el("section", "myra-card myra-card-confirm")
      add(card, el("p", "myra-card-title", component.title))
      add(card, el("p", "myra-p", component.description))
      add(card, el("p", "myra-meta", `Expires ${component.expiresAt}`))
      renderMyraProposalActions(
        card,
        {
          id: component.proposalId,
          title: component.title,
          description: component.description,
          confirmLabel: component.confirmLabel,
          expiresAt: component.expiresAt,
        },
        context
      )
      add(host, card)
      return
    }
    case "action_result": {
      const card = el("section", "myra-card")
      const head = el("div", "myra-result-head")
      add(head, statusChip(component.status))
      add(head, el("span", "myra-check-label", component.title))
      add(card, head)
      if (component.detail) add(card, el("p", "myra-p", component.detail))
      if (component.reference) add(card, el("p", "myra-meta", `Reference ${component.reference}`))
      if (component.status === "COMPLETED") context.markActionCompleted()
      add(host, card)
      return
    }
    case "guided_flow": {
      const card = el("section", "myra-card")
      const head = el("div", "myra-result-head")
      add(head, el("span", "myra-card-title", component.flowTitle))
      add(head, statusChip(component.status))
      add(card, head)
      const ol = el("ol", "myra-steps")
      component.steps.forEach((step, idx) => {
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
      for (const s of component.suggestions) {
        const li = el("li")
        add(li, el("span", "myra-check-label", s.title))
        add(li, el("p", "myra-note", s.snippet))
        const href = safeMyraHref(s.sourceUrl)
        if (href) appendMyraLink(li, href, "Source", "myra-link")
        add(ul, li)
      }
      add(card, ul)
      add(host, card)
      return
    }
    case "memory_card": {
      const card = el("section", "myra-card")
      add(card, el("p", "myra-card-title", "What Myra remembers"))
      if (!component.entries.length) {
        add(card, el("p", "myra-note", "Nothing stored for this session."))
      } else {
        const ul = el("ul", "myra-checks")
        for (const entry of component.entries) {
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
      for (const item of component.canSee) {
        const li = el("li")
        add(li, el("span", "myra-check-label", item))
        add(ul, li)
      }
      for (const item of component.cannotSee) {
        const li = el("li")
        add(li, el("span", "myra-note", `Not ${item}`))
        add(ul, li)
      }
      add(details, ul)
      add(host, details)
      return
    }
    case "trace_ref": {
      add(host, el("p", "myra-trace", `trace ${component.traceId}`))
      context.setLastTraceId(component.traceId)
      return
    }
    default:
      return
  }
}
