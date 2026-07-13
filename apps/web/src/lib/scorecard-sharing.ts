export type ScorecardVariant = "grade" | "fixes"
export type ScorecardFormat = "wide" | "square" | "portrait"
export const SCORECARD_CHANNELS = [
  "native",
  "linkedin",
  "x",
  "bluesky",
  "whatsapp",
  "reddit",
  "email",
  "copy",
  "download",
  "embed",
] as const
export const REFERRAL_SOURCES = ["scorecard", ...SCORECARD_CHANNELS] as const
export type ScorecardChannel = (typeof SCORECARD_CHANNELS)[number]
export type ShareChannel = Exclude<ScorecardChannel, "native" | "copy" | "download" | "embed">

export function scorecardUrlWithSource(url: string, source: string) {
  const tracked = new URL(url)
  tracked.searchParams.set("source", source)
  tracked.searchParams.set("utm_source", source)
  tracked.searchParams.set("utm_medium", source === "embed" ? "badge" : "social")
  return tracked.toString()
}

export function scorecardCaption(
  grade: string,
  resolvedFindings: number,
  variant: ScorecardVariant
) {
  const fixes = `${resolvedFindings} finding${resolvedFindings === 1 ? "" : "s"}`
  return variant === "fixes"
    ? `${fixes} fixed and retest-verified with LyraShield AI. Current scoped grade: ${grade}.`
    : `We ran a scoped LyraShield AI security review and earned grade ${grade}, with ${fixes} fixed and retest-verified.`
}

export function scorecardChannelUrl(channel: ShareChannel, url: string, caption: string) {
  const sourcedUrl = scorecardUrlWithSource(url, channel)
  const encodedUrl = encodeURIComponent(sourcedUrl)
  const encodedCaption = encodeURIComponent(caption)
  const textWithUrl = encodeURIComponent(`${caption}\n\n${sourcedUrl}`)
  switch (channel) {
    case "linkedin":
      return `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`
    case "x":
      return `https://twitter.com/intent/tweet?text=${encodedCaption}&url=${encodedUrl}`
    case "bluesky":
      return `https://bsky.app/intent/compose?text=${textWithUrl}`
    case "whatsapp":
      return `https://wa.me/?text=${textWithUrl}`
    case "reddit":
      return `https://www.reddit.com/submit?url=${encodedUrl}&title=${encodedCaption}`
    case "email":
      return `mailto:?subject=${encodeURIComponent("Our LyraShield AI security review")}&body=${textWithUrl}`
  }
}

export function scorecardEmbed(url: string, badgeUrl: string) {
  return `[![Scanned by LyraShield AI](${badgeUrl})](${url})`
}
