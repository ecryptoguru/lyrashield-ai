"use client"

import { useState } from "react"
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
      aria-label={label}
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
      <p className="text-muted-foreground text-sm leading-6">{step.summary}</p>

      {step.snippet ? (
        <div className="space-y-1.5">
          {step.snippetPath ? (
            <p className="text-muted-foreground font-mono text-[11px]">{step.snippetPath}</p>
          ) : null}
          <div className="relative">
            <pre
              className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-5"
              tabIndex={0}
              aria-label="Configuration snippet"
            >
              <code>{step.snippet}</code>
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton
                value={step.snippet}
                label={step.copyLabel ?? "Copy config"}
                copyKey={`${agentId}:${step.id}:snippet`}
                copiedKey={copiedKey}
                onCopy={onCopy}
              />
            </div>
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

  async function handleCopy(value: string, key: string) {
    setCopyError(null)
    try {
      await writeClipboard(value)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 2000)
    } catch {
      setCopyError(key.split(":").slice(0, 2).join(":"))
    }
  }

  return (
    <div className="space-y-5">
      <ol className="space-y-4">
        {data.steps.map((step, index) => (
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

      <p className="text-muted-foreground text-sm">
        Full guide for {data.displayName}:{" "}
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
        >
          /docs/integrations/{data.docsSlug}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </p>
    </div>
  )
}
