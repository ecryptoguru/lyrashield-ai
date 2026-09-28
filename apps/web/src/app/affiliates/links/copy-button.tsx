"use client"

import { useState } from "react"

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API may not be available
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className="min-h-11 min-w-11 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Link copied to clipboard." : ""}
      </span>
    </>
  )
}
