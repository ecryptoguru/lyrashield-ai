"use client"

import Image from "next/image"
import { useEffect, useState } from "react"
import { Check, Code2, Copy, Download, ExternalLink, Share2 } from "lucide-react"
import { Button } from "@lyrashield/ui"
import {
  scorecardCaption,
  scorecardChannelUrl,
  scorecardEmbed,
  scorecardUrlWithSource,
  type ScorecardFormat,
  type ScorecardVariant,
  type ShareChannel,
} from "../lib/scorecard-sharing"

const FORMATS: { value: ScorecardFormat; label: string }[] = [
  { value: "wide", label: "Link preview" },
  { value: "portrait", label: "Feed image" },
  { value: "square", label: "Square" },
]

function trackingAllowed() {
  const navigatorWithGpc = navigator as Navigator & { globalPrivacyControl?: boolean }
  return navigator.doNotTrack !== "1" && navigatorWithGpc.globalPrivacyControl !== true
}

function visitorId() {
  const key = "lyrashield-scorecard-visitor"
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(value),
        new Promise((_, reject) =>
          window.setTimeout(() => reject(new Error("Clipboard timed out")), 1000)
        ),
      ])
      return
    } catch {
      // Fall through for browsers that expose Clipboard API but deny or stall it.
    }
  }
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  if (!copied) throw new Error("Clipboard unavailable")
}

export function ScorecardShareComposer({
  slug,
  url,
  grade,
  resolvedFindings,
  source,
}: {
  slug: string
  url: string
  grade: string
  resolvedFindings: number
  source: "dashboard" | "public"
}) {
  const [variant, setVariant] = useState<ScorecardVariant>("grade")
  const [format, setFormat] = useState<ScorecardFormat>("wide")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const caption = scorecardCaption(grade, resolvedFindings, variant)
  const cardPath = `/api/og/score/${slug}?variant=${variant}&format=${format}`

  const absolute = (path: string) => new URL(path, window.location.origin).toString()
  const track = async (channel?: string, eventType: "VIEW" | "SHARE" = "SHARE") => {
    if (!trackingAllowed()) return
    try {
      await fetch("/api/scorecards/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          eventType,
          channel,
          variant,
          source,
          visitorId: visitorId(),
        }),
      })
    } catch {
      // Analytics must never block sharing.
    }
  }

  useEffect(() => {
    if (source === "public") void track(undefined, "VIEW")
    // The endpoint deduplicates React strict-mode and repeat session views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, slug])

  const copy = async (value: string, message: string, channel: "copy" | "embed" = "copy") => {
    try {
      await writeClipboard(value)
      setError(null)
      setNotice(message)
      await track(channel)
    } catch {
      setError("Clipboard access is unavailable. Open the scorecard and copy from your browser.")
    }
  }

  const openChannel = async (channel: ShareChannel) => {
    const shareUrl = scorecardChannelUrl(channel, absolute(url), caption)
    window.open(shareUrl, "_blank", "noopener,noreferrer")
    await track(channel)
  }

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(cardPath)
      if (!response.ok) throw new Error("Card unavailable")
      const blobUrl = URL.createObjectURL(await response.blob())
      const anchor = document.createElement("a")
      anchor.href = blobUrl
      anchor.download = `lyrashield-${variant}-${format}.png`
      anchor.click()
      URL.revokeObjectURL(blobUrl)
      setNotice("Card downloaded.")
      await track("download")
    } catch {
      setError("Could not download this card. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const nativeShare = async () => {
    if (!navigator.share) {
      await copy(
        `${caption}\n\n${scorecardUrlWithSource(absolute(url), "copy")}`,
        "Post and link copied."
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/og/score/${slug}?variant=${variant}&format=square`)
      const file = response.ok
        ? new File([await response.blob()], `lyrashield-${variant}.png`, { type: "image/png" })
        : null
      const canShareFile = file && navigator.canShare?.({ files: [file] })
      const sourcedUrl = scorecardUrlWithSource(absolute(url), "native")
      await navigator.share({
        title: "LyraShield AI security review",
        ...(canShareFile
          ? { files: [file], text: `${caption}\n\n${sourcedUrl}` }
          : { text: caption, url: sourcedUrl }),
      })
      setNotice("Shared from your device.")
      await track("native")
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      setError("Your device could not open the share sheet. Copy the post instead.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="bg-card overflow-hidden rounded-xl border"
      aria-labelledby={`share-${slug}`}
    >
      <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,1fr)]">
        <div className="bg-muted/30 border-b p-4 sm:p-6 lg:border-r lg:border-b-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id={`share-${slug}`} className="font-semibold">
                Share verified progress
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Only the approved public scorecard fields appear.
              </p>
            </div>
            <div className="flex rounded-lg border p-1" aria-label="Card message">
              {(["grade", "fixes"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded-md px-3 py-1.5 text-xs font-medium ${variant === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  aria-pressed={variant === value}
                  onClick={() => setVariant(value)}
                >
                  {value === "grade" ? "Grade" : "Verified fixes"}
                </button>
              ))}
            </div>
          </div>
          <div className="relative aspect-[1200/630] overflow-hidden rounded-lg border bg-[#07110f] shadow-lg">
            <Image
              key={cardPath}
              src={cardPath}
              alt={`${variant === "grade" ? `Grade ${grade}` : `${resolvedFindings} verified fixes`} LyraShield AI sharing card preview`}
              fill
              unoptimized
              loading={source === "public" ? "eager" : "lazy"}
              sizes="(max-width: 1024px) 100vw, 60vw"
              className="object-cover"
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Download format">
            {FORMATS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`rounded-full border px-3 py-1.5 text-xs ${format === item.value ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
                aria-pressed={format === item.value}
                onClick={() => setFormat(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col justify-center p-4 sm:p-6">
          <p className="text-muted-foreground text-sm leading-relaxed">{caption}</p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button onClick={() => void nativeShare()} disabled={busy} className="col-span-2">
              <Share2 className="mr-2 h-4 w-4" aria-hidden="true" />
              Share
            </Button>
            <Button variant="secondary" onClick={() => void openChannel("linkedin")}>
              LinkedIn
            </Button>
            <Button variant="secondary" onClick={() => void openChannel("x")}>
              X
            </Button>
            <Button variant="secondary" onClick={() => void openChannel("bluesky")}>
              Bluesky
            </Button>
            <Button variant="secondary" onClick={() => void openChannel("whatsapp")}>
              WhatsApp
            </Button>
            <Button variant="secondary" onClick={() => void openChannel("reddit")}>
              Reddit
            </Button>
            <Button variant="secondary" onClick={() => void openChannel("email")}>
              Email
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void copy(
                  `${caption}\n\n${scorecardUrlWithSource(absolute(url), "copy")}`,
                  "Post and link copied."
                )
              }
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Copy post
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void download()} disabled={busy}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Download
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void copy(
                  scorecardEmbed(
                    scorecardUrlWithSource(absolute(url), "embed"),
                    absolute(`/api/badge/score/${slug}`)
                  ),
                  "README badge Markdown copied.",
                  "embed"
                )
              }
            >
              <Code2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> README badge
            </Button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="hover:bg-accent inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium"
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Open
            </a>
          </div>
          {notice && (
            <p className="text-primary mt-4 flex items-center gap-2 text-sm" role="status">
              <Check className="h-4 w-4" aria-hidden="true" /> {notice}
            </p>
          )}
          {error && (
            <p className="text-destructive mt-4 text-sm" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
