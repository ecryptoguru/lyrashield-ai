"use client"

import { useState, type Dispatch, type SetStateAction } from "react"
import { writeClipboard } from "@/components/scorecard-share-composer"

const clipboardError = "Failed to copy API key. Copy it manually or check your browser permissions."

export function useApiKeyCopy(
  rawKey: string | undefined,
  setError: Dispatch<SetStateAction<string | null>>
) {
  const [copied, setCopied] = useState(false)
  // Sticky "has copied at least once" flag — `copied` resets after the icon
  // flash, but the dismiss gate must stay open once the key has been copied.
  const [hasCopiedKey, setHasCopiedKey] = useState(false)

  async function copyKey() {
    if (rawKey === undefined) return
    try {
      await writeClipboard(rawKey)
      setError((current) => (current === clipboardError ? null : current))
      setCopied(true)
      setHasCopiedKey(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(clipboardError)
      setCopied(false)
      // Clipboard access can be denied outright. Unlock the dismiss button so a
      // user who copies the key by hand is not trapped with an undismissable
      // banner — the warning above still tells them it is shown only once.
      setHasCopiedKey(true)
    }
  }

  return { copied, hasCopiedKey, setHasCopiedKey, copyKey }
}
