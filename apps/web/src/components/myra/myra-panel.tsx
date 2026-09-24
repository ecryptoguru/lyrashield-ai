"use client"

/**
 * Myra support launcher and panel for the dashboard.
 *
 * Renders only allowlisted components; all model text passes through
 * sanitizeMarkdown and JSX escaping — no innerHTML anywhere. Same-origin
 * requests use the cookie session (apiBase ""); anonymous/public tokens never
 * apply on this surface.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { MessageCircleQuestion, Send, Square, X } from "lucide-react"
import { isManifestRoute, MYRA_COPY, MYRA_LIMITS } from "@lyrashield/myra"
import { Button, cn } from "@lyrashield/ui"
import { MyraComponentView, MyraMarkdown, ProposalActions } from "./myra-presentation"
import { useMyraPanel } from "./use-myra-panel"

/** Route context is an allowlisted path identifier, never page content. */
function routeContextFor(pathname: string, surface: "marketing" | "app"): string | undefined {
  let path = pathname.replace(/\/+$/, "") || "/"
  for (;;) {
    if (isManifestRoute(path, surface)) return path
    const idx = path.lastIndexOf("/")
    if (idx <= 0) return isManifestRoute("/", surface) ? "/" : undefined
    path = path.slice(0, idx)
  }
}

// ─── Panel ──────────────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function MyraPanel({
  enabled = true,
  accountEmail,
  accountName,
}: {
  enabled?: boolean
  /** Signed-in account identity — prefills the demo-booking attendee step. */
  accountEmail?: string | null
  accountName?: string | null
}) {
  const pathname = usePathname()
  const routeContext = routeContextFor(pathname ?? "/", "app")

  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileLauncherRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const mobileCloseRef = useRef<HTMLButtonElement | null>(null)
  const isModal = mobileOpen
  const {
    turns,
    input,
    streaming,
    activity,
    announcement,
    suggestions,
    suggestActive,
    caseForm,
    logRef,
    inputRef,
    setCaseForm,
    send,
    stopStream,
    onInputChange,
    onInputKeyDown,
    pickSuggestion,
    submitCaseForm,
    componentContext,
    rateAnswer,
  } = useMyraPanel(routeContext, { email: accountEmail, name: accountName })

  const starters = [
    { label: "Help with this page", send: "Help with this page" },
    { label: "Check setup", send: "Check setup" },
    { label: "Understand this result", send: "Understand this result" },
  ]

  // Escape closes the mobile sheet; focus returns to the launcher.
  const closeMobile = useCallback(() => {
    setMobileOpen(false)
    requestAnimationFrame(() => mobileLauncherRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!isModal) return
    const panel = panelRef.current
    // Focus enters the sheet when it opens. The close button is the entry
    // point rather than the composer — focusing the textarea would pop the
    // virtual keyboard over half the sheet on touch devices.
    mobileCloseRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMobile()
        return
      }
      if (e.key !== "Tab" || !panel) return
      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement
      const inside = active instanceof HTMLElement && panel.contains(active)
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [isModal, closeMobile])

  if (!enabled) return null

  const body = (
    <>
      <div className="border-border/80 bg-card/95 flex items-center gap-3 border-b px-4 py-3.5 pt-[max(0.875rem,env(safe-area-inset-top))]">
        <span
          aria-hidden="true"
          className="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ring-current/15"
        >
          <MessageCircleQuestion className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-muted-foreground font-mono text-[10px] font-semibold tracking-[0.16em] uppercase">
            LyraShield support
          </p>
          <h2 className="text-foreground text-base font-semibold leading-5 tracking-tight">
            {MYRA_COPY.header}
          </h2>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="text-primary h-9 px-2 text-xs"
            onClick={() => {
              setCaseForm({
                subject: "",
                summary: "",
                includeDiagnostics: false,
                includeTranscript: false,
              })
            }}
          >
            <span className="sm:hidden">Support</span>
            <span className="hidden sm:inline">{MYRA_COPY.talkToPerson}</span>
          </Button>
          <Button
            ref={mobileCloseRef}
            size="icon"
            variant="ghost"
            className="size-9"
            aria-label="Close Myra"
            onClick={closeMobile}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div
        ref={logRef}
        role="log"
        aria-label="Conversation with Myra"
        aria-busy={streaming || undefined}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5"
      >
        {turns.length === 0 && !caseForm ? (
          <div className="border-primary/20 bg-primary/[0.035] rounded-2xl border-l-[3px] px-4 py-4">
            <p className="text-foreground text-sm leading-relaxed">{MYRA_COPY.opener}</p>
            <p className="text-muted-foreground mt-2 text-xs leading-5">
              I’ll use LyraShield guidance where I have it and help you reach support when I don’t.
            </p>
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Suggested starting points">
              {starters.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => void send(s.send)}
                  className="border-border bg-background focus-visible:ring-ring inline-flex min-h-11 items-center rounded-full border px-3.5 text-xs font-medium transition-colors hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:outline-none"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            <div className="bg-primary/10 ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2.5">
              <p className="text-sm wrap-break-word whitespace-pre-wrap">{turn.userText}</p>
            </div>
            <div className="space-y-2">
              {turn.parts.map((part, i) =>
                part.kind === "answer" ? (
                  <MyraMarkdown key={i} text={part.markdown} />
                ) : part.kind === "component" ? (
                  <MyraComponentView
                    key={i}
                    component={part.component}
                    context={componentContext}
                  />
                ) : (
                  <div key={i} className="border-primary/40 rounded-lg border p-3">
                    <p className="text-sm font-medium">{part.proposal.title}</p>
                    <p className="mt-1 text-sm">{part.proposal.description}</p>
                    {part.proposal.expiresAt ? (
                      <p className="text-muted-foreground mt-2 font-mono text-xs">
                        Expires {part.proposal.expiresAt}
                      </p>
                    ) : null}
                    <ProposalActions
                      proposalId={part.proposal.id}
                      confirmLabel={part.proposal.confirmLabel}
                      context={componentContext}
                    />
                  </div>
                )
              )}
              {turn.stopped ? (
                <p className="text-muted-foreground text-xs">
                  {turn.completedAction
                    ? "Stopped. Actions that already completed were not undone."
                    : "Stopped — nothing was executed."}
                </p>
              ) : null}
              {turn.error ? (
                <p className="text-destructive text-xs" role="alert">
                  {turn.error}
                </p>
              ) : null}
              {turn.assistantMessageId && !turn.error ? (
                <div className="flex items-center gap-2 text-xs" aria-label="Rate Myra's answer">
                  <span className="text-muted-foreground">Was this helpful?</span>
                  {(["helpful", "not_helpful"] as const).map((rating) => (
                    <button
                      key={rating}
                      type="button"
                      disabled={turn.ratingPending}
                      aria-pressed={turn.rating === rating}
                      onClick={() => void rateAnswer(turn.id, turn.assistantMessageId!, rating)}
                      className="focus-visible:ring-ring min-h-11 rounded-md border px-2 focus-visible:ring-2"
                    >
                      {rating === "helpful" ? "Yes" : "No"}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {caseForm ? (
          <div className="border-primary/40 space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Talk to a person</p>
            <p className="text-muted-foreground text-xs">
              Tell us what happened. Myra will prepare a case summary for you to review before
              anything is sent.
            </p>
            <input
              type="text"
              value={caseForm.subject}
              maxLength={160}
              placeholder="Subject"
              aria-label="Case subject"
              onChange={(e) => setCaseForm((f) => f && { ...f, subject: e.target.value })}
              className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
            <textarea
              value={caseForm.summary}
              rows={4}
              maxLength={4000}
              placeholder="What happened? What were you trying to do?"
              aria-label="Case details"
              onChange={(e) => setCaseForm((f) => f && { ...f, summary: e.target.value })}
              className="border-input bg-background focus-visible:ring-ring w-full resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={caseForm.includeDiagnostics}
                onChange={(e) =>
                  setCaseForm((f) => f && { ...f, includeDiagnostics: e.target.checked })
                }
                className="accent-primary size-4"
              />
              Include a diagnostic excerpt
            </label>
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={caseForm.includeTranscript}
                onChange={(e) =>
                  setCaseForm((f) => f && { ...f, includeTranscript: e.target.checked })
                }
                className="accent-primary size-4"
              />
              Include a transcript excerpt
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={submitCaseForm}>
                Review with Myra
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCaseForm(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {activity ? (
        <p className="text-muted-foreground px-4 pb-1 font-mono text-xs" aria-live="off">
          {activity}
        </p>
      ) : null}

      <div className="border-border/80 bg-card/95 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="relative">
          <label htmlFor="myra-dash-input" className="sr-only">
            Message Myra
          </label>
          <textarea
            ref={inputRef}
            id="myra-dash-input"
            rows={2}
            maxLength={MYRA_LIMITS.messageMaxChars}
            placeholder="Ask about this page, setup or results…"
            autoComplete="off"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            aria-autocomplete="list"
            aria-controls="myra-dash-suggest"
            aria-activedescendant={
              suggestActive >= 0 ? `myra-dash-suggest-${suggestActive}` : undefined
            }
            className="border-input bg-background focus-visible:ring-ring w-full resize-none rounded-xl border px-3 py-2.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          {suggestions.length ? (
            <ul
              id="myra-dash-suggest"
              role="listbox"
              aria-label="Instant answers"
              className="bg-popover absolute inset-x-0 bottom-full mb-1 max-h-44 overflow-y-auto rounded-md border shadow-md"
            >
              {suggestions.map((s, i) => (
                <li
                  key={s.entryId}
                  id={`myra-dash-suggest-${i}`}
                  role="option"
                  aria-selected={i === suggestActive}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    pickSuggestion(s)
                  }}
                  className={cn("cursor-pointer px-3 py-2", i === suggestActive && "bg-accent")}
                >
                  <p className="text-xs font-medium">{s.title}</p>
                  <p className="text-muted-foreground line-clamp-2 text-xs">{s.snippet}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          {streaming ? (
            <p className="text-muted-foreground text-xs">Myra is answering…</p>
          ) : (
            <p className="text-muted-foreground text-xs">Enter to send · Shift+Enter for a line</p>
          )}
          <div className="flex gap-2">
            {streaming ? (
              <Button size="sm" variant="secondary" onClick={stopStream}>
                <Square className="mr-1 size-3" aria-hidden="true" />
                Stop
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => void send(input)}
              disabled={!input.trim() || streaming}
            >
              <Send className="mr-1 size-3.5" aria-hidden="true" />
              Send
            </Button>
          </div>
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  )

  return (
    <>
      {/* Launcher sits above mobile navigation and the device safe area. On
          desktop it moves to the bottom-right so it never covers the sidebar's
          Sign out and theme controls in the bottom-left corner. */}
      <Button
        ref={mobileLauncherRef}
        type="button"
        size="sm"
        variant="secondary"
        aria-expanded={mobileOpen}
        aria-controls="myra-dash-panel"
        onClick={() => setMobileOpen(true)}
        className="border-primary/20 bg-card text-foreground hover:border-primary fixed right-4 bottom-20 z-40 min-h-11 gap-2 rounded-full border px-4 shadow-[0_12px_38px_-14px_rgba(0,0,0,0.45)] transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:shadow-lg motion-reduce:transform-none sm:right-6 lg:right-6 lg:bottom-24 lg:left-auto"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
      >
        <MessageCircleQuestion className="size-4" aria-hidden="true" />
        Ask Myra
      </Button>

      <aside
        ref={panelRef}
        id="myra-dash-panel"
        aria-label="Myra support"
        role="dialog"
        aria-modal={isModal || undefined}
        className={
          mobileOpen
            ? // `w-screen max-w-full` plus `overflow-hidden` pins the mobile sheet
              // to the viewport. `inset-0` alone let long unbroken content (a wide
              // table, a long URL in an answer) push the panel wider than the
              // screen, which scrolled the whole page sideways instead of scrolling
              // inside the message log. The log itself keeps overflow-y-auto.
              "bg-background fixed inset-0 z-50 flex w-screen max-w-full flex-col overflow-hidden lg:inset-auto lg:bottom-6 lg:left-6 lg:h-[min(650px,calc(100dvh-3rem))] lg:w-[min(420px,calc(100vw-3rem))] lg:rounded-2xl lg:border lg:border-border/80 lg:shadow-[0_28px_90px_-30px_rgba(0,0,0,0.65)]"
            : "hidden"
        }
      >
        {body}
      </aside>
    </>
  )
}
