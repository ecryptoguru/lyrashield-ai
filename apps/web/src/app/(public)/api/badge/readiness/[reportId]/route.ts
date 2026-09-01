import { getSharedLaunchReport } from "@lyrashield/db"

export const dynamic = "force-dynamic"

/**
 * GET /api/badge/readiness/[reportId]?token=…
 *
 * A README badge reflecting a target's launch-gate verdict, backed by a shared
 * Launch Readiness Report (the token is the public capability — same model as
 * the shared report page). The badge reflects a gate result against the named
 * readiness standard; it never implies the app is "secure".
 *
 * Stale or insufficient-evidence states render honestly: a stale verdict shows
 * "stale", insufficient evidence shows "not enough evidence", and a revoked or
 * expired share returns 404 so the badge fails closed rather than showing a
 * stale pass.
 */
export async function GET(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params
  const token = new URL(request.url).searchParams.get("token")
  if (!token) return new Response(null, { status: 404 })

  const payload = await getSharedLaunchReport(reportId, token)
  if (!payload) return new Response(null, { status: 404 })

  const { text, color, labelColor } = badgeFor(payload.verdictLabel, payload.stale)

  const label = "launch gate"
  const labelWidth = 92
  const valueWidth = Math.max(64, text.length * 7 + 16)
  const width = labelWidth + valueWidth
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" role="img" aria-label="${label}: ${escapeXml(text)}">
  <title>${label}: ${escapeXml(text)}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-opacity=".08"/></linearGradient>
  <clipPath id="r"><rect width="${width}" height="28" rx="6"/></clipPath>
  <g clip-path="url(#r)"><rect width="${labelWidth}" height="28" fill="${labelColor}"/><rect x="${labelWidth}" width="${valueWidth}" height="28" fill="${color}"/><rect width="${width}" height="28" fill="url(#s)"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Arial,sans-serif" font-size="11" font-weight="600"><text x="${labelWidth / 2}" y="18">${label}</text><text x="${labelWidth + valueWidth / 2}" y="18">${escapeXml(text)}</text></g>
</svg>`
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  })
}

function badgeFor(
  verdictLabel: string,
  stale: boolean
): { text: string; color: string; labelColor: string } {
  if (stale) return { text: "stale — re-run", color: "#8a6d1a", labelColor: "#14211e" }
  switch (verdictLabel) {
    case "Ready to launch":
      return { text: "passing", color: "#178f70", labelColor: "#14211e" }
    case "Not ready":
      return { text: "not ready", color: "#b3261e", labelColor: "#14211e" }
    default:
      return { text: "not enough evidence", color: "#5b6470", labelColor: "#14211e" }
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
