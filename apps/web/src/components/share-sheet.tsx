"use client"

import { useState } from "react"
import { Link2, Check, Mail, MessageCircle, Download } from "lucide-react"
import { BottomSheet } from "./bottom-sheet"
import { track } from "@/lib/analytics"

interface ShareSheetProps {
  open: boolean
  onClose: () => void
  title: string
  shareUrl: string
  description?: string
}

const CHANNELS: {
  id: string
  label: string
  icon:
    | React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
    | (() => React.ReactElement)
}[] = [
  { id: "copy", label: "Copy link", icon: Link2 },
  {
    id: "x",
    label: "X",
    icon: function XIcon(props) {
      return (
        <span {...props} aria-hidden="true">
          𝕏
        </span>
      )
    },
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    icon: function LinkedInIcon(props) {
      return (
        <span {...props} aria-hidden="true">
          in
        </span>
      )
    },
  },
  {
    id: "facebook",
    label: "Facebook",
    icon: function FacebookIcon(props) {
      return (
        <span {...props} aria-hidden="true">
          f
        </span>
      )
    },
  },
  { id: "email", label: "Email", icon: Mail },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { id: "download", label: "Download", icon: Download },
]

export function ShareSheet({ open, onClose, title, shareUrl, description }: ShareSheetProps) {
  const [copied, setCopied] = useState(false)

  async function handleChannel(channel: string) {
    const text = description ? `${title} — ${description}` : title
    track("share_created", { variant: "scorecard", channel })

    switch (channel) {
      case "copy":
        await navigator.clipboard.writeText(shareUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        break
      case "x":
        window.open(
          `https://twitter.com/intent/tweet?${new URLSearchParams({ url: shareUrl, text })}`,
          "_blank",
          "noopener,noreferrer"
        )
        break
      case "linkedin":
        window.open(
          `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`,
          "_blank",
          "noopener,noreferrer"
        )
        break
      case "facebook":
        window.open(
          `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
          "_blank",
          "noopener,noreferrer"
        )
        break
      case "email":
        window.open(
          `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text + "\n\n" + shareUrl)}`,
          "_blank"
        )
        break
      case "whatsapp":
        window.open(
          `https://wa.me/?text=${encodeURIComponent(text + " " + shareUrl)}`,
          "_blank",
          "noopener,noreferrer"
        )
        break
      case "download":
        window.open(shareUrl, "_blank", "noopener,noreferrer")
        break
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={`Share ${title}`}>
      <div className="grid grid-cols-4 gap-2">
        {CHANNELS.map((channel) => {
          const Icon = channel.icon
          return (
            <button
              key={channel.id}
              onClick={() => handleChannel(channel.id)}
              className="hover:bg-accent flex flex-col items-center gap-2 rounded-lg p-2 text-center text-xs transition-colors"
            >
              {channel.id === "copy" && copied ? (
                <Check className="size-6 text-emerald-500" aria-hidden={true} />
              ) : (
                <Icon className="size-6" aria-hidden={true} />
              )}
              <span className="text-muted-foreground">{channel.label}</span>
            </button>
          )
        })}
      </div>
      <p className="text-muted-foreground mt-4 text-xs">
        Shared scorecards use privacy-safe public links. They never expose target, repository, or
        finding data.
      </p>
    </BottomSheet>
  )
}
