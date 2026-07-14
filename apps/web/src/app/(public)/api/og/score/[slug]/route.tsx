import { ImageResponse } from "next/og"
import { getPublicScorecard } from "@lyrashield/db"

export const runtime = "nodejs"

const FORMATS = {
  wide: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
} as const

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const scorecard = await getPublicScorecard(slug)
  if (!scorecard) return new Response(null, { status: 404 })

  const url = new URL(request.url)
  const formatParam = url.searchParams.get("format")
  const variant = url.searchParams.get("variant") === "fixes" ? "fixes" : "grade"
  const format = formatParam === "square" || formatParam === "portrait" ? formatParam : "wide"
  const { width, height } = FORMATS[format]
  const { payload, superseded } = scorecard
  const grade = payload.grade.replace("_PLUS", "+")
  const isTall = format !== "wide"

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#07110f",
        color: "#ecfff9",
        padding: isTall ? "76px" : "58px 68px",
        fontFamily: "sans-serif",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 85% 12%, rgba(57, 211, 164, 0.22), transparent 34%), linear-gradient(rgba(74, 222, 178, 0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(74, 222, 178, 0.055) 1px, transparent 1px)",
          backgroundSize: "auto, 48px 48px, 48px 48px",
        }}
      />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              display: "flex",
              width: 42,
              height: 42,
              border: "2px solid #4adeb2",
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              color: "#4adeb2",
              fontSize: 22,
              fontWeight: 800,
            }}
          >
            L
          </div>
          <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: "0.08em" }}>
            LYRASHIELD AI
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 18, color: "#9dbbb1" }}>
          {new Date(payload.scannedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          })}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: isTall ? "column" : "row",
          alignItems: isTall ? "flex-start" : "flex-end",
          justifyContent: "space-between",
          gap: 34,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", maxWidth: isTall ? 900 : 730 }}>
          <div
            style={{
              display: "flex",
              color: "#4adeb2",
              fontSize: variant === "fixes" ? (isTall ? 142 : 112) : isTall ? 260 : 190,
              lineHeight: 0.9,
              fontWeight: 850,
              letterSpacing: "-0.06em",
            }}
          >
            {variant === "fixes" ? payload.resolvedFindings : grade}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 20,
              fontSize: isTall ? 46 : 36,
              lineHeight: 1.1,
              fontWeight: 700,
            }}
          >
            {variant === "fixes"
              ? `finding${payload.resolvedFindings === 1 ? "" : "s"} fixed and retest-confirmed`
              : "LyraShield Score"}
          </div>
          <div
            style={{ display: "flex", marginTop: 18, fontSize: isTall ? 28 : 22, color: "#9dbbb1" }}
          >
            {variant === "fixes"
              ? `Current grade ${grade}`
              : `${payload.resolvedFindings} retest-confirmed fixes`}
            {superseded ? " · newer scan available" : ""}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: isTall ? "flex-start" : "flex-end",
            gap: 10,
            fontSize: isTall ? 24 : 19,
            color: "#b9cec7",
          }}
        >
          <div style={{ display: "flex" }}>{payload.scope}</div>
          <div style={{ display: "flex", color: "#78958c" }}>
            Scoped assessment · not a security guarantee
          </div>
        </div>
      </div>
    </div>,
    {
      width,
      height,
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=60",
        "Content-Disposition": `inline; filename="lyrashield-${variant}-${format}.png"`,
      },
    }
  )
}
