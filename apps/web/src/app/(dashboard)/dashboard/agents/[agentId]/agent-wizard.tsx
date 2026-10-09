"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import { Button } from "@lyrashield/ui"
import { writeClipboard } from "@/components/scorecard-share-composer"
import type { AgentWizardData, WizardStep } from "@/lib/agent-wizard"

function CopyButton({
  value,
  label,
  copyKey,
  copiedKey,
  onCopy,
}: {
  value: string
  label: string
  copyKey: string
  copiedKey: string | null
  onCopy: (value: string, key: string) => void
}) {
  const copied = copiedKey === copyKey
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => onCopy(value, copyKey)}
      aria-label={copied ? `${label}: copied` : label}
      className="min-h-11 shrink-0 sm:min-h-9"
    >
      {copied ? (
        <Check className="size-4" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
      <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
    </Button>
  )
}

function StepBody({
  step,
  agentId,
  copiedKey,
  copyError,
  onCopy,
}: {
  step: WizardStep
  agentId: string
  copiedKey: string | null
  copyError: string | null
  onCopy: (value: string, key: string) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground break-words text-sm leading-6">{step.summary}</p>

      {step.snippet ? (
        <div className="space-y-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="text-muted-foreground min-w-0 font-mono text-xs break-all">
              {step.snippetPath ?? "Connection values"}
            </p>
            <CopyButton
              value={step.snippet}
              label={step.copyLabel ?? "Copy config"}
              copyKey={`${agentId}:${step.id}:snippet`}
              copiedKey={copiedKey}
              onCopy={onCopy}
            />
          </div>
          <div className="min-w-0">
            <pre
              className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs leading-5"
              tabIndex={0}
              aria-label="Configuration snippet"
            >
              <code>{step.snippet}</code>
            </pre>
          </div>
        </div>
      ) : null}

      {step.command ? (
        <div className="flex w-full min-w-0 items-center gap-2">
          <code
            className="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2.5 font-mono text-xs whitespace-nowrap sm:text-sm"
            tabIndex={0}
            aria-label="Setup command"
          >
            {step.command}
          </code>
          <CopyButton
            value={step.command}
            label={step.copyLabel ?? "Copy command"}
            copyKey={`${agentId}:${step.id}:command`}
            copiedKey={copiedKey}
            onCopy={onCopy}
          />
        </div>
      ) : null}

      {step.note ? (
        <p className="text-muted-foreground bg-muted/40 rounded-md border px-3 py-2 text-xs leading-relaxed">
          {step.note}
        </p>
      ) : null}

      {copyError === `${agentId}:${step.id}` ? (
        <p role="alert" className="text-destructive text-xs">
          Copy failed. Select the text manually.
        </p>
      ) : null}
    </div>
  )
}

export function AgentWizard({ data, docsUrl }: { data: AgentWizardData; docsUrl: string }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    []
  )

  async function handleCopy(value: string, key: string) {
    setCopyError(null)
    setCopiedKey(null)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    try {
      await writeClipboard(value)
      setCopiedKey(key)
      copyTimer.current = setTimeout(() => setCopiedKey(null), 2000)
    } catch {
      setCopyError(key.split(":").slice(0, 2).join(":"))
    }
  }

  return (
    <div className="space-y-5">
      <p role="status" aria-live="polite" className="sr-only">
        {copiedKey ? "Copied to clipboard." : ""}
      </p>
      <section
        className="grid gap-3 md:grid-cols-2"
        aria-label="Compatibility and distribution status"
      >
        <div className="bg-card min-w-0 space-y-2 rounded-xl border p-4">
          <h2 className="text-sm font-semibold">Compatibility evidence</h2>
          <p className="text-sm">
            Support tier: <span className="font-medium">{data.supportTier}</span>
            {data.surface ? ` · ${data.surface} surface` : ""}
          </p>
          <p className="text-muted-foreground text-xs leading-5">
            Evidence: {data.verification?.evidence ?? "not recorded"}
            {data.verification?.checkedOn ? `, checked ${data.verification.checkedOn}` : ""}.
            {data.verification?.clientVersion
              ? ` Client version: ${data.verification.clientVersion}.`
              : " Client version not recorded."}
          </p>
          {data.verification?.reference ? (
            <p className="text-muted-foreground text-xs leading-5">
              Reference:{" "}
              {data.verification.reference.startsWith("https://") ? (
                <a
                  href={data.verification.reference}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground break-all underline underline-offset-2 hover:no-underline"
                >
                  {data.verification.reference}
                </a>
              ) : (
                <code>{data.verification.reference}</code>
              )}
            </p>
          ) : null}
          {data.nativeCapabilities.length > 0 ? (
            <p className="text-muted-foreground text-xs leading-5">
              Client supports (documented): {data.nativeCapabilities.join(", ")}.
            </p>
          ) : null}
          {data.versionConstraints ? (
            <p className="text-muted-foreground text-xs leading-5">
              Client version requirements:{" "}
              {data.versionConstraints.note ??
                [
                  data.versionConstraints.minimum
                    ? `minimum ${data.versionConstraints.minimum}`
                    : "",
                  data.versionConstraints.maximum
                    ? `maximum ${data.versionConstraints.maximum}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
              . Check your client version before choosing this setup.
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs leading-5">
            Runtime receipt: {data.verification?.receipt ? "on file" : "not recorded"}. A configured
            file alone does not confirm the client loaded the integration; verify it below.
          </p>
        </div>

        <div className="bg-card min-w-0 space-y-2 rounded-xl border p-4">
          <h2 className="text-sm font-semibold">Distribution channel</h2>
          <p className="text-sm">
            State: <span className="font-medium">{data.distribution?.state ?? "UNKNOWN"}</span>
          </p>
          {data.distribution ? (
            <p className="text-muted-foreground text-xs leading-5">
              {data.distribution.channel}:{" "}
              <a
                href={data.distribution.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-2 hover:no-underline"
              >
                view channel details
              </a>
            </p>
          ) : (
            <p className="text-muted-foreground text-xs leading-5">
              No marketplace or direct-distribution state is recorded.
            </p>
          )}
          <p className="text-muted-foreground text-xs leading-5">
            Distribution status is separate from client compatibility.
          </p>
        </div>
      </section>

      <ol className="space-y-4">
        {data.steps
          .filter((step) => !step.optional)
          .map((step, index) => (
            <li key={step.id} className="bg-card rounded-xl border shadow-xs">
              <div className="flex items-start gap-4 p-5">
                <span
                  className="bg-primary/10 text-primary mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold tracking-tight">{step.title}</h3>
                  <div className="mt-3">
                    <StepBody
                      step={step}
                      agentId={data.agentId}
                      copiedKey={copiedKey}
                      copyError={copyError}
                      onCopy={handleCopy}
                    />
                  </div>
                </div>
              </div>
            </li>
          ))}
      </ol>

      {data.steps
        .filter((step) => step.optional)
        .map((step) => (
          <details key={step.id} className="bg-card min-w-0 rounded-xl border">
            <summary className="cursor-pointer rounded-xl p-5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2">
              {step.title}
            </summary>
            <div className="min-w-0 px-5 pb-5">
              <StepBody
                step={step}
                agentId={data.agentId}
                copiedKey={copiedKey}
                copyError={copyError}
                onCopy={handleCopy}
              />
            </div>
          </details>
        ))}

      <section
        className="space-y-3 rounded-xl border bg-card p-5"
        aria-labelledby="agent-next-step"
      >
        <h2 id="agent-next-step" className="text-sm font-semibold">
          Continue with a scan
        </h2>
        <p className="text-muted-foreground text-sm">
          After verifying the connection in your client, choose a target and confirm a scan. You can
          also scan from the dashboard without installing a coding agent.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/dashboard/scans?new=1"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium"
          >
            Configure a scan
          </Link>
          <Link
            href="/dashboard/connections"
            className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
          >
            Review connections
          </Link>
        </div>
      </section>
      <p className="text-muted-foreground text-sm">
        Full guide for {data.displayName}:{" "}
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground inline-flex max-w-full items-center gap-1 break-all underline underline-offset-2 hover:no-underline"
        >
          /docs/integrations/{data.docsSlug}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </p>
    </div>
  )
}
