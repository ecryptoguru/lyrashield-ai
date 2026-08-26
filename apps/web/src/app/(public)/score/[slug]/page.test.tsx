import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ getPublicScorecard: vi.fn() }))

import { getPublicScorecard } from "@lyrashield/db"
import { generateMetadata } from "./page"

describe("public scorecard metadata", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("uses the authenticated app origin when the shared image was built for the scanner", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.lyrashieldai.com")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://scanner.lyrashieldai.com")
    vi.mocked(getPublicScorecard).mockResolvedValue({
      payload: {
        grade: "F",
        scope: "Scoped security review",
        scannedAt: "2026-08-26T00:00:00.000Z",
        modelVersion: "score-v1",
        resolvedFindings: 0,
        releaseVerdict: "NO_GO",
        verdictVersion: "score-v1",
      },
      referralCode: null,
      superseded: false,
    })

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "SCORECARD" }) })

    expect(metadata.alternates?.canonical).toBe("https://app.lyrashieldai.com/score/SCORECARD")
    expect(
      metadata.openGraph && "images" in metadata.openGraph && metadata.openGraph.images
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://app.lyrashieldai.com/api/og/score/SCORECARD?variant=fixes&format=wide",
        }),
      ])
    )
  })
})
