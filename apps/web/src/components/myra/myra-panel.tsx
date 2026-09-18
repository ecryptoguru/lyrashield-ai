"use client"

/**
 * Myra docked support panel for the dashboard (spec §3/§13).
 *
 * Renders only allowlisted components; all model text passes through
 * sanitizeMarkdown and JSX escaping — no innerHTML anywhere. Same-origin
 * requests use the cookie session (apiBase ""); anonymous/public tokens never
 * apply on this surface.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import {
  MessageCircleQuestion,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
  X,
} from "lucide-react"
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

  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileLauncherRef = useRef<HTMLButtonElement | null>(null)
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
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobile()
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [mobileOpen, closeMobile])

  if (!enabled) return null

  const body = (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h2 className="font-mono text-xs font-semibold tracking-[0.14em] uppercase">
          {MYRA_COPY.header}
        </h2>
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
            {MYRA_COPY.talkToPerson}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="hidden size-9 lg:inline-flex"
            aria-label={collapsed ? "Expand Myra panel" : "Collapse Myra panel"}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? (
              <PanelRightOpen className="size-4" aria-hidden="true" />
            ) : (
              <PanelRightClose className="size-4" aria-hidden="true" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-9 lg:hidden"
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
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {turns.length === 0 && !caseForm ? (
          <div>
            <p className="text-sm leading-relaxed">{MYRA_COPY.opener}</p>
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested starting points">
              {starters.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => void send(s.send)}
                  className="border-border focus-visible:ring-ring inline-flex min-h-11 items-center rounded-full border px-3.5 text-xs font-medium hover:border-current focus-visible:ring-2 focus-visible:outline-none"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            <div className="bg-accent ml-auto w-fit max-w-[85%] rounded-lg px-3 py-2">
              <p className="text-sm break-words whitespace-pre-wrap">{turn.userText}</p>
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

      <div className="border-t p-3">
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
            className="border-input bg-background focus-visible:ring-ring w-full resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
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
      {/* Mobile launcher — sits above the bottom nav, safe-area aware. */}
      <Button
        ref={mobileLauncherRef}
        type="button"
        size="sm"
        variant="secondary"
        aria-expanded={mobileOpen}
        aria-controls="myra-dash-panel"
        onClick={() => setMobileOpen(true)}
        className="fixed right-4 bottom-20 z-40 gap-1.5 shadow-md lg:hidden"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
      >
        <MessageCircleQuestion className="size-4" aria-hidden="true" />
        Help
      </Button>

      {/*
        One DOM tree, two presentations:
          <lg  → hidden until the launcher opens it as a full-height fixed sheet
          lg+  → docked beside content; collapses to a slim rail, never a bubble
      */}
      <aside
        id="myra-dash-panel"
        aria-label="Myra support"
        className={cn(
          "bg-background flex-col",
          mobileOpen ? "fixed inset-0 z-50 flex" : "hidden",
          "lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-svh lg:shrink-0 lg:self-start lg:border-l",
          collapsed ? "lg:w-14" : "lg:w-88 xl:w-96"
        )}
      >
        {collapsed && !mobileOpen ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Expand Myra support panel"
            className="focus-visible:ring-ring flex h-full w-full flex-col items-center gap-3 py-4 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
          >
            <MessageCircleQuestion className="text-muted-foreground size-5" aria-hidden="true" />
            <span className="text-muted-foreground font-mono text-[0.625rem] tracking-[0.2em] [writing-mode:vertical-rl]">
              MYRA
            </span>
          </button>
        ) : (
          body
        )}
      </aside>
    </>
  )
}
