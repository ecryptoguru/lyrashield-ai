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
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  )
}
