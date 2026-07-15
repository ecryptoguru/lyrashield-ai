import { ImageResponse } from "next/og"
import { parseLiteScorecardToken } from "@/lib/lite-scorecard"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const payload = parseLiteScorecardToken(token)
  if (!payload) return new Response(null, { status: 404 })
  const reviewCount = payload.needsAttention + payload.worthReviewing

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#07131d",
        color: "#edf8fb",
        padding: "58px 68px",
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
            "radial-gradient(circle at 84% 16%, rgba(84,214,223,.2), transparent 34%), linear-gradient(rgba(84,214,223,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(84,214,223,.05) 1px, transparent 1px)",
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
              border: "2px solid #54d6df",
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              color: "#54d6df",
              fontSize: 22,
              fontWeight: 800,
            }}
          >
            L
          </div>
          <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: ".08em" }}>
            LYRASHIELD AI
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 18, color: "#91a7b8" }}>PASSIVE LITE CHECK</div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 44,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 700 }}>
          <div
            style={{
              display: "flex",
              color: "#54d6df",
              fontSize: 190,
              lineHeight: 0.84,
              fontWeight: 850,
              letterSpacing: "-.06em",
            }}
          >
            {reviewCount}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 24,
              fontSize: 38,
              lineHeight: 1.05,
              fontWeight: 700,
            }}
          >
            {reviewCount === 0
              ? "No surface issues found"
              : `thing${reviewCount === 1 ? "" : "s"} worth a look`}
          </div>
        </div>
        <div
          style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 280, fontSize: 21 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 40 }}>
            <span style={{ color: "#91a7b8" }}>Needs attention</span>
            <strong>{payload.needsAttention}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 40 }}>
            <span style={{ color: "#91a7b8" }}>Worth reviewing</span>
            <strong>{payload.worthReviewing}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 40 }}>
            <span style={{ color: "#91a7b8" }}>Looks OK</span>
            <strong>{payload.looksOk}</strong>
          </div>
        </div>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", color: "#91a7b8", fontSize: 18 }}
      >
        <span>Outside-only public surface check</span>
        <span>Not a security guarantee</span>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Disposition": 'inline; filename="lyrashield-lite-check.png"',
      },
    }
  )
}
