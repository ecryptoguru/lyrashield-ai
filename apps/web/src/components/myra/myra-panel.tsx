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
import {
  createMyraClient,
  isManifestRoute,
  sanitizeLinkHref,
  sanitizeMarkdown,
  MYRA_COPY,
  MYRA_LIMITS,
  type MyraClient,
  type MyraComponent,
  type MyraStreamEvent,
} from "@lyrashield/myra"
import { Badge, Button, cn } from "@lyrashield/ui"

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProposalView {
  id: string
  title: string
  description: string
  confirmLabel: string
  expiresAt?: string
}

/** UI state for a proposal id, shared by every card bound to it. */
type ProposalState = "pending" | "working" | "done" | "cancelled"

type Part =
  | { kind: "answer"; markdown: string }
  | { kind: "component"; component: MyraComponent }
  | { kind: "proposal"; proposal: ProposalView }

interface Turn {
  id: number
  userText: string
  parts: Part[]
  stopped?: boolean
  error?: string | null
  completedAction?: boolean
}

interface Suggestion {
  entryId: string
  title: string
  snippet: string
  sourceUrl?: string
}

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

function safeHref(raw: string | undefined, surface: "marketing" | "app", requireManifest = false) {
  if (!raw) return null
  const href = sanitizeLinkHref(raw)
  if (!href) return null
  if (requireManifest && href.startsWith("/") && !isManifestRoute(href, surface)) return null
  return href
}

// ─── Markdown (inline segments + minimal blocks; renderer owns all markup) ──

function InlineText({ text }: { text: string }) {
  const segments = sanitizeMarkdown(text)
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "code" ? (
          <code
            key={i}
            className="bg-muted rounded-sm border px-1 font-mono text-[0.8125rem]"
          >
            {seg.text}
          </code>
        ) : seg.kind === "link" && seg.href ? (
          <a
            key={i}
            href={seg.href}
            className="text-primary underline underline-offset-4 break-words"
            {...(seg.href.startsWith("/")
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" })}
          >
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}

export function MyraMarkdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  let inFence = false
  let codeLines: string[] = []
  let listItems: string[] = []
  let para: string[] = []

  const flushPara = (key: number) => {
    if (!para.length) return
    blocks.push(
      <p key={`p${key}`} className="text-sm leading-relaxed">
        {para.map((line, i) => (
          <InlineText key={i} text={line} />
        )).reduce<React.ReactNode[]>((acc, node, i) => (i ? [...acc, " ", node] : [node]), [])}
      </p>
    )
    para = []
  }
  const flushList = (key: number) => {
    if (!listItems.length) return
    blocks.push(
      <ul key={`ul${key}`} className="list-disc space-y-1 pl-5 text-sm">
        {listItems.map((line, i) => (
          <li key={i}>
            <InlineText text={line} />
          </li>
        ))}
      </ul>
    )
    listItems = []
  }
  const flushCode = (key: number) => {
    if (!codeLines.length) return
    blocks.push(
      <pre
        key={`pre${key}`}
        className="bg-muted overflow-x-auto rounded-md border p-2.5 font-mono text-[0.8125rem]"
      >
        <code>{codeLines.join("\n")}</code>
      </pre>
    )
    codeLines = []
  }

  text.split("\n").forEach((raw, idx) => {
    const trimmed = raw.trim()
    if (trimmed.startsWith("```")) {
      if (inFence) flushCode(idx)
      inFence = !inFence
      flushPara(idx)
      flushList(idx)
      return
    }
    if (inFence) {
      codeLines.push(raw)
      return
    }
    if (!trimmed) {
      flushPara(idx)
      flushList(idx)
      return
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/) ?? trimmed.match(/^\d{1,2}[.)]\s+(.*)$/)
    if (bullet && bullet[1] !== undefined) {
      flushPara(idx)
      listItems.push(bullet[1])
      return
    }
    flushList(idx)
    para.push(trimmed)
  })
  flushPara(10_000)
  flushList(10_000)
  if (inFence) flushCode(10_000)
  return <div className="space-y-2">{blocks}</div>
}

// ─── Component renderers ────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const s = status.toLowerCase().replace(/_/g, " ")
  const variant =
    status === "pass" || status === "done" || status === "COMPLETED"
      ? "success"
      : status === "fail" || status === "blocked" || status === "FAILED"
        ? "danger"
        : status === "unknown" || status === "OUTCOME_UNKNOWN" || status === "pending"
          ? "warning"
          : "muted"
  return <Badge variant={variant}>{s}</Badge>
}

interface ComponentCtx {
  onPickSlot: (startsAt: string) => void
  onConfirm: (proposalId: string) => void
  onCancel: (proposalId: string) => void
  onForgetMemory: () => void
  proposalStates: Record<string, { state: ProposalState; statusText?: string }>
}

function ComponentView({ c, ctx }: { c: MyraComponent; ctx: ComponentCtx }) {
  switch (c.type) {
    case "answer":
      return <MyraMarkdown text={c.markdown} />
    case "source_link": {
      const href = safeHref(c.url, "app")
      if (!href) return null
      return (
        <a
          href={href}
          className="text-primary text-sm underline underline-offset-4 break-words"
          {...(href.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        >
          {c.label}
        </a>
      )
    }
    case "plan_comparison":
      return (
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Plan comparison</p>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">Checked {c.checkedAt}</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1 pr-3 font-medium">Plan</th>
                  <th className="py-1 pr-3 font-medium">Price</th>
                  <th className="py-1 pr-3 font-medium">Minutes</th>
                  <th className="py-1 font-medium">Availability</th>
                </tr>
              </thead>
              <tbody>
                {c.plans.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{p.name}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {p.monthlyUsd != null
                        ? `$${p.monthlyUsd}/mo`
                        : p.monthlyInr != null
                          ? `₹${p.monthlyInr}/mo`
                          : "Contact us"}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {p.agentMinutes != null ? p.agentMinutes : "—"}
                    </td>
                    <td className="py-1.5">
                      <StatusChip status={p.availability} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.note ? <p className="text-muted-foreground mt-2 text-xs">{c.note}</p> : null}
          {(() => {
            const href = safeHref(c.plans.find((p) => p.ctaRoute)?.ctaRoute, "app", true)
            return href ? (
              <a
                href={href}
                className="text-primary mt-2 inline-block text-xs underline underline-offset-4"
              >
                Open billing
              </a>
            ) : null
          })()}
        </div>
      )
    case "diagnostic_status":
      return (
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">{c.title}</p>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">Checked {c.checkedAt}</p>
          <ul className="mt-2 space-y-1.5">
            {c.checks.map((check) => {
              const href = safeHref(check.ctaRoute, "app", true)
              return (
                <li key={check.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <StatusChip status={check.status} />
                  <span>{check.label}</span>
                  {check.detail ? (
                    <span className="text-muted-foreground basis-full text-xs">
                      {check.detail}
                    </span>
                  ) : null}
                  {href ? (
                    <a href={href} className="text-primary text-xs underline underline-offset-4">
                      Open
                    </a>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      )
    case "task_steps":
      return (
        <div className="rounded-lg border p-3">
          <ol className="space-y-1.5">
            {c.steps.map((step) => {
              const href = safeHref(step.ctaRoute, "app", true)
              return (
                <li key={step.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <StatusChip status={step.status} />
                  <span>{step.title}</span>
                  {step.detail ? (
                    <p className="text-muted-foreground basis-full text-xs">{step.detail}</p>
                  ) : null}
                  {href ? (
                    <a href={href} className="text-primary text-xs underline underline-offset-4">
                      Open
                    </a>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </div>
      )
    case "support_case_preview":
      return (
        <div className="border-primary/40 rounded-lg border p-3">
          <p className="text-sm font-medium">{MYRA_COPY.caseDraft}</p>
          <p className="mt-1 text-sm font-semibold">{c.subject}</p>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">{c.summary}</p>
          <p className="text-muted-foreground mt-2 font-mono text-xs">
            Replies go to {c.replyDestination}
          </p>
          <p className="text-muted-foreground font-mono text-xs">
            {c.includeDiagnostics || c.includeTranscriptExcerpt
              ? `Includes ${[
                  c.includeDiagnostics ? "diagnostic excerpt" : null,
                  c.includeTranscriptExcerpt ? "transcript excerpt" : null,
                ]
                  .filter(Boolean)
                  .join(" and ")}.`
              : "No diagnostics or transcript attached."}
          </p>
          <p className="text-muted-foreground font-mono text-xs">Expires {c.expiresAt}</p>
          <ProposalActions ctx={ctx} proposalId={c.proposalId} confirmLabel="Send to support" />
        </div>
      )
    case "slot_picker":
      return (
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Pick a time</p>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">
            Times shown in {c.displayTimezone}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {c.slots.map((slot) => {
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
              return (
                <Button
                  key={slot.id}
                  size="sm"
                  variant="secondary"
                  className="justify-start"
                  onClick={() => ctx.onPickSlot(slot.startsAt)}
                >
                  {label}
                </Button>
              )
            })}
          </div>
        </div>
      )
    case "action_confirmation":
      return (
        <div className="border-primary/40 rounded-lg border p-3">
          <p className="text-sm font-medium">{c.title}</p>
          <p className="mt-1 text-sm">{c.description}</p>
          <p className="text-muted-foreground mt-2 font-mono text-xs">Expires {c.expiresAt}</p>
          <ProposalActions ctx={ctx} proposalId={c.proposalId} confirmLabel={c.confirmLabel} />
        </div>
      )
    case "action_result":
      return (
        <div className="rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <StatusChip status={c.status} />
            <span className="text-sm font-medium">{c.title}</span>
          </div>
          {c.detail ? <p className="mt-1.5 text-sm">{c.detail}</p> : null}
          {c.reference ? (
            <p className="text-muted-foreground mt-1 font-mono text-xs">
              Reference {c.reference}
            </p>
          ) : null}
        </div>
      )
    case "guided_flow":
      return (
        <div className="rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{c.flowTitle}</span>
            <StatusChip status={c.status} />
          </div>
          <ol className="mt-2 space-y-1.5">
            {c.steps.map((step, idx) => (
              <li key={step.id} className="flex items-baseline gap-2 text-sm">
                <StatusChip status={step.status} />
                <span>
                  {idx + 1}. {step.title}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )
    case "instant_suggestions":
      return (
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Instant answers</p>
          <ul className="mt-2 space-y-2">
            {c.suggestions.map((s) => {
              const href = safeHref(s.sourceUrl, "app")
              return (
                <li key={s.entryId}>
                  <p className="text-sm font-medium">{s.title}</p>
                  <p className="text-muted-foreground text-xs">{s.snippet}</p>
                  {href ? (
                    <a
                      href={href}
                      className="text-primary text-xs underline underline-offset-4"
                      {...(href.startsWith("/")
                        ? {}
                        : { target: "_blank", rel: "noopener noreferrer" })}
                    >
                      Source
                    </a>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      )
    case "memory_card":
      return (
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">What Myra remembers</p>
          {c.entries.length ? (
            <ul className="mt-2 space-y-1">
              {c.entries.map((entry) => (
                <li key={entry.key} className="text-muted-foreground text-sm">
                  {entry.label}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-1 text-xs">Nothing stored for this session.</p>
          )}
          <button
            type="button"
            onClick={ctx.onForgetMemory}
            className="text-primary mt-2 text-xs underline underline-offset-4"
          >
            Ask Myra to forget these
          </button>
        </div>
      )
    case "capability_line":
      return (
        <details className="text-muted-foreground text-xs">
          <summary className="focus-visible:ring-ring cursor-pointer font-mono tracking-wide rounded-sm focus-visible:ring-2 focus-visible:outline-none">
            What Myra checked
          </summary>
          <ul className="mt-1.5 space-y-1">
            {c.canSee.map((item, i) => (
              <li key={`c${i}`}>{item}</li>
            ))}
            {c.cannotSee.map((item, i) => (
              <li key={`x${i}`} className="text-muted-foreground/70">
                Not {item}
              </li>
            ))}
          </ul>
        </details>
      )
    case "trace_ref":
      return (
        <p className="text-muted-foreground/70 font-mono text-[0.6875rem]">trace {c.traceId}</p>
      )
    default:
      return null
  }
}

function ProposalActions({
  proposalId,
  confirmLabel,
  ctx,
}: {
  proposalId: string
  confirmLabel?: string
  ctx: ComponentCtx
}) {
  const state = ctx.proposalStates[proposalId] ?? { state: "pending" as ProposalState }
  if (state.state === "done") {
    return (
      <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
        {state.statusText ?? "Done."}
      </p>
    )
  }
  if (state.state === "cancelled") {
    return (
      <p className="text-muted-foreground mt-2 text-xs">Canceled — nothing was executed.</p>
    )
  }
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={state.state === "working"}
          onClick={() => ctx.onConfirm(proposalId)}
        >
          {state.state === "working" ? "Working…" : confirmLabel || "Confirm"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.state === "working"}
          onClick={() => ctx.onCancel(proposalId)}
        >
          Cancel
        </Button>
      </div>
      {state.statusText ? (
        <p className="text-muted-foreground text-xs" role="status">
          {state.statusText}
        </p>
      ) : null}
    </div>
  )
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export function MyraPanel({ enabled = true }: { enabled?: boolean }) {
  const pathname = usePathname()
  const routeContext = routeContextFor(pathname ?? "/", "app")

  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [proposalStates, setProposalStates] = useState<
    Record<string, { state: ProposalState; statusText?: string }>
  >({})
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestActive, setSuggestActive] = useState(-1)
  const [caseForm, setCaseForm] = useState<{
    subject: string
    summary: string
    includeDiagnostics: boolean
    includeTranscript: boolean
  } | null>(null)

  const turnsRef = useRef<Turn[]>([])
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])
  const clientRef = useRef<MyraClient | null>(null)
  const conversationIdRef = useRef<string | undefined>(undefined)
  const lastTraceRef = useRef<string | undefined>(undefined)
  const turnSeq = useRef(0)
  const streamAbortRef = useRef<AbortController | null>(null)
  const suggestAbortRef = useRef<AbortController | null>(null)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const logRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const mobileLauncherRef = useRef<HTMLButtonElement | null>(null)
  const stoppedTurnRef = useRef<number | null>(null)

  const getClient = useCallback((): MyraClient => {
    clientRef.current = createMyraClient({
      apiBase: "",
      surface: "DASHBOARD",
      routeContext,
    })
    return clientRef.current
  }, [routeContext])

  const announce = useCallback((text: string) => setAnnouncement(text), [])

  const scrollLogToEnd = useCallback(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  const updateTurn = useCallback((id: number, fn: (t: Turn) => Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)))
  }, [])

  const handleEvent = useCallback(
    (ev: MyraStreamEvent, turnId: number) => {
      switch (ev.type) {
        case "ready":
          conversationIdRef.current = ev.conversationId
          lastTraceRef.current = ev.traceId
          return
        case "activity":
          setActivity(ev.label)
          return
        case "token":
          updateTurn(turnId, (t) => {
            const parts = [...t.parts]
            const last = parts[parts.length - 1]
            if (last && last.kind === "answer") {
              parts[parts.length - 1] = { kind: "answer", markdown: last.markdown + ev.text }
            } else {
              parts.push({ kind: "answer", markdown: ev.text })
            }
            return { ...t, parts }
          })
          return
        case "component":
          if (ev.component.type === "trace_ref") lastTraceRef.current = ev.component.traceId
          updateTurn(turnId, (t) => ({
            ...t,
            completedAction:
              t.completedAction ||
              (ev.component.type === "action_result" && ev.component.status === "COMPLETED"),
            parts: [...t.parts, { kind: "component", component: ev.component }],
          }))
          scrollLogToEnd()
          return
        case "proposal":
          updateTurn(turnId, (t) => {
            // The loop emits a structured confirm card AND this event for the
            // same proposal — skip the generic card when the rich card exists.
            const already = t.parts.some(
              (p) =>
                p.kind === "component" &&
                (p.component.type === "action_confirmation" ||
                  p.component.type === "support_case_preview") &&
                p.component.proposalId === ev.proposal.id
            )
            if (already) return t
            return {
              ...t,
              parts: [
                ...t.parts,
                {
                  kind: "proposal",
                  proposal: {
                    id: ev.proposal.id,
                    title: ev.proposal.title,
                    description: ev.proposal.description,
                    confirmLabel: "Confirm",
                    expiresAt: ev.proposal.expiresAt,
                  },
                },
              ],
            }
          })
          announce("Myra prepared an action for you to confirm.")
          scrollLogToEnd()
          return
        case "operation":
          setProposalStates((s) => ({
            ...s,
            [ev.operationId]: {
              ...(s[ev.operationId] ?? { state: "pending" }),
              statusText: `Status: ${ev.status.toLowerCase().replace(/_/g, " ")}`,
            },
          }))
          updateTurn(turnId, (t) => ({
            ...t,
            completedAction: t.completedAction || ev.status === "COMPLETED",
          }))
          return
        case "done":
          setActivity(null)
          if (lastTraceRef.current) {
            const traceId = lastTraceRef.current
            updateTurn(turnId, (t) => ({
              ...t,
              parts: [
                ...t.parts,
                { kind: "component", component: { type: "trace_ref", traceId } },
              ],
            }))
          }
          announce("Myra finished responding.")
          scrollLogToEnd()
          return
        case "error":
          setActivity(null)
          updateTurn(turnId, (t) => ({ ...t, error: ev.error.message }))
          announce(`Error: ${ev.error.message}`)
          return
      }
    },
    [announce, scrollLogToEnd, updateTurn]
  )

  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim().slice(0, MYRA_LIMITS.messageMaxChars)
      if (!text) return
      if (streamAbortRef.current) {
        // A turn is in flight — keep the draft, tell the user why.
        announce("Myra is still answering — wait a moment or press Stop.")
        return
      }
      setSuggestions([])
      setSuggestActive(-1)
      setInput("")
      const turnId = ++turnSeq.current
      setTurns((prev) => [...prev, { id: turnId, userText: text, parts: [] }])
      setStreaming(true)
      setActivity("Working on it…")
      announce("Message sent.")
      const abort = new AbortController()
      streamAbortRef.current = abort
      let received = false
      try {
        for await (const ev of getClient().sendMessage({
          text,
          conversationId: conversationIdRef.current,
          signal: abort.signal,
        })) {
          received = true
          handleEvent(ev, turnId)
        }
      } catch (err) {
        if (abort.signal.aborted || (err as Error).name === "AbortError") {
          // Stopped by user — state was already marked in stopStream.
        } else {
          const code = (err as { code?: string }).code
          setActivity(null)
          if (!received) {
            // Send never reached the server — keep the draft rather than lose it.
            setInput(text)
          }
          updateTurn(turnId, (t) => ({
            ...t,
            error:
              code === "PROPOSAL_EXPIRED"
                ? "That request expired — ask Myra to prepare it again."
                : !received
                  ? "Something went wrong before Myra replied. Your message is back in the composer."
                  : "Something went wrong. Try again or talk to a person.",
          }))
          announce("Message failed.")
        }
      } finally {
        streamAbortRef.current = null
        setStreaming(false)
        setActivity(null)
      }
    },
    [announce, getClient, handleEvent, updateTurn]
  )

  const stopStream = useCallback(() => {
    if (!streamAbortRef.current) return
    streamAbortRef.current.abort()
    streamAbortRef.current = null
    setStreaming(false)
    setActivity(null)
    const id = turnSeq.current
    stoppedTurnRef.current = id
    updateTurn(id, (t) => ({ ...t, stopped: true }))
    announce("Stopped — generation canceled. Anything already confirmed was not undone.")
  }, [announce, updateTurn])

  const turnHoldingProposal = useCallback(
    (proposalId: string) =>
      turnsRef.current.find((t) =>
        t.parts.some(
          (p) =>
            (p.kind === "proposal" && p.proposal.id === proposalId) ||
            (p.kind === "component" &&
              (p.component.type === "action_confirmation" ||
                p.component.type === "support_case_preview" ||
                p.component.type === "action_result") &&
              p.component.proposalId === proposalId)
        )
      )?.id,
    []
  )

  const confirmProposalAction = useCallback(
    async (proposalId: string) => {
      const turnId = turnHoldingProposal(proposalId) ?? turnSeq.current
      const setProposal = (
        fn: (s: { state: ProposalState; statusText?: string }) => {
          state: ProposalState
          statusText?: string
        }
      ) =>
        setProposalStates((s) => ({
          ...s,
          [proposalId]: fn(s[proposalId] ?? { state: "pending" }),
        }))
      setProposal(() => ({ state: "working" }))
      try {
        const raw = (await getClient().confirmProposal(proposalId)) as {
          data?: { status?: string; result?: unknown; component?: MyraComponent }
        }
        const data = raw?.data ?? (raw as { status?: string; component?: MyraComponent })
        setProposal(() => ({
          state: "done",
          statusText: data?.status
            ? `Done — ${String(data.status).toLowerCase().replace(/_/g, " ")}.`
            : "Done.",
        }))
        if (data?.component) {
          updateTurn(turnId, (t) => ({
            ...t,
            completedAction: t.completedAction || data.status === "COMPLETED",
            parts: [...t.parts, { kind: "component", component: data.component! }],
          }))
        }
        announce("Action confirmed.")
      } catch (err) {
        const code = (err as { code?: string }).code
        setProposal(() => ({
          state: "pending",
          statusText:
            code === "PROPOSAL_EXPIRED"
              ? "That request expired — ask Myra to prepare it again."
              : code === "PROPOSAL_PAYLOAD_CHANGED"
                ? "The details changed — review the new summary before confirming."
                : code === "TAKEOVER_ACTIVE"
                  ? "A person is handling this conversation."
                  : "The action could not be completed. Try again or ask for a person.",
        }))
        announce("Action could not be confirmed.")
      }
    },
    [announce, getClient, turnHoldingProposal, updateTurn]
  )

  const cancelProposalAction = useCallback(
    async (proposalId: string) => {
      try {
        await getClient().cancelProposal(proposalId)
      } catch {
        /* cancellation failures still render the canceled state client-side */
      }
      setProposalStates((s) => ({ ...s, [proposalId]: { state: "cancelled" } }))
      announce("Action canceled.")
    },
    [announce, getClient]
  )

  // Debounced instant suggestions — retrieval only, never a model call.
  const onInputChange = useCallback(
    (value: string) => {
      setInput(value)
      clearTimeout(suggestTimerRef.current)
      const text = value.trim()
      if (text.length < 2) {
        setSuggestions([])
        setSuggestActive(-1)
        return
      }
      suggestTimerRef.current = setTimeout(() => {
        suggestAbortRef.current?.abort()
        suggestAbortRef.current = new AbortController()
        getClient()
          .suggest(text.slice(0, 300), suggestAbortRef.current.signal)
          .then((res) => {
            const payload =
              res && typeof res === "object" && "data" in res
                ? (res as { data: { suggestions?: Suggestion[] } }).data
                : (res as { suggestions?: Suggestion[] })
            setSuggestions((payload.suggestions ?? []).slice(0, 3))
            setSuggestActive(-1)
          })
          .catch(() => {
            /* suggestions are best-effort */
          })
      }, 150)
    },
    [getClient]
  )

  const pickSuggestion = useCallback(
    (s: Suggestion) => {
      setSuggestions([])
      setSuggestActive(-1)
      const turnId = ++turnSeq.current
      setTurns((prev) => [
        ...prev,
        {
          id: turnId,
          userText: s.title,
          parts: [
            { kind: "answer", markdown: s.snippet },
            ...(safeHref(s.sourceUrl, "app")
              ? [
                  {
                    kind: "component" as const,
                    component: {
                      type: "source_link" as const,
                      label: "Source",
                      url: s.sourceUrl!,
                    },
                  },
                ]
              : []),
          ],
        },
      ])
      announce("Instant answer shown.")
    },
    [announce]
  )

  const submitCaseForm = useCallback(() => {
    if (!caseForm) return
    const subject = caseForm.subject.trim()
    const summary = caseForm.summary.trim()
    if (subject.length < 4 || summary.length < 10) {
      announce("Add a subject and a few words about what happened.")
      return
    }
    const parts = [
      "Please prepare a support case for me.",
      `Subject: ${subject}`,
      `Details: ${summary}`,
      `Include diagnostic excerpt: ${caseForm.includeDiagnostics ? "yes" : "no"}`,
      `Include transcript excerpt: ${caseForm.includeTranscript ? "yes" : "no"}`,
      ...(lastTraceRef.current ? [`Attach trace: ${lastTraceRef.current}`] : []),
    ]
    setCaseForm(null)
    void send(parts.join("\n"))
  }, [announce, caseForm, send])

  // Escape closes the suggestion list first, then the mobile sheet.
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestions.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault()
          setSuggestActive(
            (a) =>
              (a + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length
          )
          return
        }
        if ((e.key === "Enter" || e.key === "Tab") && suggestActive >= 0) {
          e.preventDefault()
          const picked = suggestions[suggestActive]
          if (picked) pickSuggestion(picked)
          return
        }
        if (e.key === "Escape") {
          setSuggestions([])
          setSuggestActive(-1)
          return
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        void send(input)
      }
    },
    [input, pickSuggestion, send, suggestActive, suggestions]
  )

  const componentCtx: ComponentCtx = {
    onPickSlot: (startsAt) => void send(`Book the demo slot that starts at ${startsAt}`),
    onConfirm: (proposalId) => void confirmProposalAction(proposalId),
    onCancel: (proposalId) => void cancelProposalAction(proposalId),
    onForgetMemory: () => void send("Please forget what you have remembered about me."),
    proposalStates,
  }

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
            className="hidden size-9 md:inline-flex"
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
            className="size-9 md:hidden"
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
                  <ComponentView key={i} c={part.component} ctx={componentCtx} />
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
                      ctx={componentCtx}
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
                  className={cn(
                    "cursor-pointer px-3 py-2",
                    i === suggestActive && "bg-accent"
                  )}
                >
                  <p className="text-xs font-medium">{s.title}</p>
                  <p className="text-muted-foreground line-clamp-2 text-xs">{s.snippet}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">Enter to send · Shift+Enter for a line</p>
          <div className="flex gap-2">
            {streaming ? (
              <Button size="sm" variant="secondary" onClick={stopStream}>
                <Square className="mr-1 size-3" aria-hidden="true" />
                Stop
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void send(input)} disabled={!input.trim()}>
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
        className="fixed right-4 bottom-20 z-40 gap-1.5 shadow-md md:hidden"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
      >
        <MessageCircleQuestion className="size-4" aria-hidden="true" />
        Help
      </Button>

      {/*
        One DOM tree, two presentations:
          <md  → hidden until the launcher opens it as a full-height fixed sheet
          md+  → docked beside content; collapses to a slim rail, never a bubble
      */}
      <aside
        id="myra-dash-panel"
        aria-label="Myra support"
        className={cn(
          "bg-background flex-col",
          mobileOpen
            ? "fixed inset-0 z-50 flex"
            : "hidden",
          "md:sticky md:top-0 md:z-auto md:flex md:h-svh md:shrink-0 md:self-start md:border-l",
          collapsed ? "md:w-14" : "md:w-88 xl:w-96"
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
