"use client"

import {
  isManifestRoute,
  parseMyraMarkdownBlocks,
  sanitizeLinkHref,
  sanitizeMarkdown,
  MYRA_COPY,
  type MyraComponent,
} from "@lyrashield/myra"
import { Badge, Button } from "@lyrashield/ui"

/** UI state for a proposal id, shared by every card bound to it. */
export type ProposalState = "pending" | "working" | "done" | "cancelled"

export interface MyraComponentContext {
  onPickSlot: (startsAt: string) => void
  onConfirm: (proposalId: string) => void
  onCancel: (proposalId: string) => void
  onForgetMemory: () => void
  proposalStates: Record<string, { state: ProposalState; statusText?: string }>
}

export function safeAppHref(raw: string | undefined, requireManifest = false) {
  if (!raw) return null
  const href = sanitizeLinkHref(raw)
  if (!href) return null
  if (requireManifest && href.startsWith("/") && !isManifestRoute(href, "app")) return null
  return href
}

// ─── Markdown (inline segments + minimal blocks; renderer owns all markup) ──

function InlineText({ text }: { text: string }) {
  const segments = sanitizeMarkdown(text)
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "code" ? (
          <code key={i} className="bg-muted rounded-sm border px-1 font-mono text-[0.8125rem]">
            {seg.text}
          </code>
        ) : seg.kind === "link" && seg.href ? (
          <a
            key={i}
            href={seg.href}
            className="text-primary underline underline-offset-4 break-words"
            {...(seg.href.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
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
  const blocks = parseMyraMarkdownBlocks(text)
  return (
    <div className="space-y-2">
      {blocks.map((block, index) => {
        if (block.type === "code")
          return (
            <pre
              key={index}
              className="bg-muted overflow-x-auto rounded-md border p-2.5 font-mono text-[0.8125rem]"
            >
              <code>{block.text}</code>
            </pre>
          )
        if (block.type === "list")
          return (
            <ul key={index} className="list-disc space-y-1 pl-5 text-sm">
              {block.items.map((line, i) => (
                <li key={i}>
                  <InlineText text={line} />
                </li>
              ))}
            </ul>
          )
        return (
          <p key={index} className="text-sm leading-relaxed">
            {block.lines
              .map((line, i) => <InlineText key={i} text={line} />)
              .reduce<React.ReactNode[]>((acc, node, i) => (i ? [...acc, " ", node] : [node]), [])}
          </p>
        )
      })}
    </div>
  )
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

export function MyraComponentView({
  component,
  context,
}: {
  component: MyraComponent
  context: MyraComponentContext
}) {
  switch (component.type) {
    case "answer":
      return <MyraMarkdown text={component.markdown} />
    case "source_link": {
      const href = safeAppHref(component.url)
      if (!href) return null
      return (
        <a
          href={href}
          className="text-primary text-sm underline underline-offset-4 break-words"
          {...(href.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        >
          {component.label}
        </a>
      )
    }
    case "plan_comparison":
      return (
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Plan comparison</p>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">
            Checked {component.checkedAt}
          </p>
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
                {component.plans.map((p) => (
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
          {component.note ? (
            <p className="text-muted-foreground mt-2 text-xs">{component.note}</p>
          ) : null}
          {(() => {
            const href = safeAppHref(component.plans.find((p) => p.ctaRoute)?.ctaRoute, true)
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
          <p className="text-sm font-medium">{component.title}</p>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">
            Checked {component.checkedAt}
          </p>
          <ul className="mt-2 space-y-1.5">
            {component.checks.map((check) => {
              const href = safeAppHref(check.ctaRoute, true)
              return (
                <li key={check.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <StatusChip status={check.status} />
                  <span>{check.label}</span>
                  {check.detail ? (
                    <span className="text-muted-foreground basis-full text-xs">{check.detail}</span>
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
            {component.steps.map((step) => {
              const href = safeAppHref(step.ctaRoute, true)
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
          <p className="mt-1 text-sm font-semibold">{component.subject}</p>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">{component.summary}</p>
          <p className="text-muted-foreground mt-2 font-mono text-xs">
            Replies go to {component.replyDestination}
          </p>
          <p className="text-muted-foreground font-mono text-xs">
            {component.includeDiagnostics || component.includeTranscriptExcerpt
              ? `Includes ${[
                  component.includeDiagnostics ? "diagnostic excerpt" : null,
                  component.includeTranscriptExcerpt ? "transcript excerpt" : null,
                ]
                  .filter(Boolean)
                  .join(" and ")}.`
              : "No diagnostics or transcript attached."}
          </p>
          <p className="text-muted-foreground font-mono text-xs">Expires {component.expiresAt}</p>
          <ProposalActions
            context={context}
            proposalId={component.proposalId}
            confirmLabel="Send to support"
          />
        </div>
      )
    case "slot_picker":
      return (
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Pick a time</p>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">
            Times shown in {component.displayTimezone}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {component.slots.map((slot) => {
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
              return (
                <Button
                  key={slot.id}
                  size="sm"
                  variant="secondary"
                  className="justify-start"
                  onClick={() => context.onPickSlot(slot.startsAt)}
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
          <p className="text-sm font-medium">{component.title}</p>
          <p className="mt-1 text-sm">{component.description}</p>
          <p className="text-muted-foreground mt-2 font-mono text-xs">
            Expires {component.expiresAt}
          </p>
          <ProposalActions
            context={context}
            proposalId={component.proposalId}
            confirmLabel={component.confirmLabel}
          />
        </div>
      )
    case "action_result":
      return (
        <div className="rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <StatusChip status={component.status} />
            <span className="text-sm font-medium">{component.title}</span>
          </div>
          {component.detail ? <p className="mt-1.5 text-sm">{component.detail}</p> : null}
          {component.reference ? (
            <p className="text-muted-foreground mt-1 font-mono text-xs">
              Reference {component.reference}
            </p>
          ) : null}
        </div>
      )
    case "guided_flow":
      return (
        <div className="rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{component.flowTitle}</span>
            <StatusChip status={component.status} />
          </div>
          <ol className="mt-2 space-y-1.5">
            {component.steps.map((step, idx) => (
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
            {component.suggestions.map((s) => {
              const href = safeAppHref(s.sourceUrl)
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
          {component.entries.length ? (
            <ul className="mt-2 space-y-1">
              {component.entries.map((entry) => (
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
            onClick={context.onForgetMemory}
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
            {component.canSee.map((item, i) => (
              <li key={`c${i}`}>{item}</li>
            ))}
            {component.cannotSee.map((item, i) => (
              <li key={`x${i}`} className="text-muted-foreground/70">
                Not {item}
              </li>
            ))}
          </ul>
        </details>
      )
    case "trace_ref":
      return (
        <p className="text-muted-foreground/70 font-mono text-[0.6875rem]">
          trace {component.traceId}
        </p>
      )
    default:
      return null
  }
}

export function ProposalActions({
  proposalId,
  confirmLabel,
  context,
}: {
  proposalId: string
  confirmLabel?: string
  context: MyraComponentContext
}) {
  const state = context.proposalStates[proposalId] ?? { state: "pending" as ProposalState }
  if (state.state === "done") {
    return (
      <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
        {state.statusText ?? "Done."}
      </p>
    )
  }
  if (state.state === "cancelled") {
    return <p className="text-muted-foreground mt-2 text-xs">Canceled — nothing was executed.</p>
  }
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={state.state === "working"}
          onClick={() => context.onConfirm(proposalId)}
        >
          {state.state === "working" ? "Working…" : confirmLabel || "Confirm"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.state === "working"}
          onClick={() => context.onCancel(proposalId)}
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
