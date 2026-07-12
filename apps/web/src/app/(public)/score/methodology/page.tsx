import { SCORE_MODEL_VERSION } from "@lyrashield/score"

export default function ScoreMethodologyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold">LyraShield Score methodology</h1>
      <p className="text-muted-foreground mt-4">
        {SCORE_MODEL_VERSION} starts at 100 and deducts for current findings: verified critical −25,
        high −10, medium −4, low −1; unverified findings count at 25% weight and accepted risk at
        50% weight. Verified critical findings cap the grade at C, verified highs at B, and active
        verified secrets at D. A+ additionally requires no open findings of medium severity or
        higher.
      </p>
      <p className="text-muted-foreground mt-4">
        Scores are deterministic, versioned, and limited to the stated scan scope. They are not a
        security guarantee.
      </p>
    </main>
  )
}
