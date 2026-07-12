import { ImageResponse } from "next/og"
import { getPublicScorecard } from "@lyrashield/db"

export const runtime = "nodejs"

export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const scorecard = await getPublicScorecard(slug)
  if (!scorecard) return new Response(null, { status: 404 })
  const { payload } = scorecard
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#0b1215",
        color: "#e8fff7",
        padding: "64px",
        fontFamily: "monospace",
      }}
    >
      <div style={{ display: "flex", fontSize: 28, color: "#58e0b8" }}>LYRASHIELD AI</div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: 160, fontWeight: 800 }}>
          {payload.grade.replace("_PLUS", "+")}
        </div>
        <div style={{ display: "flex", fontSize: 34 }}>LyraShield Score</div>
      </div>
      <div style={{ display: "flex", fontSize: 22, color: "#a6bbb5" }}>
        Scanned scope: {payload.scope}
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      // Bounded cache so a revoked/superseded scorecard's OG card stops serving
      // quickly (was 24h s-maxage — a revoked card could persist on CDNs for a
      // day). Matches the page's 60s revalidation window.
      headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
    }
  )
}
