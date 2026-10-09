export interface ChapterBand {
  id: string
  start: number
  end: number
  top: number
  bottom: number
}
export interface WorldSample {
  chapter: string
  time: number
}

/** Ease the film only; native document scrolling remains immediate. */
export function easeVideoTime(from: number, to: number, elapsedMs: number): number {
  const progress = Math.max(0, Math.min(1, elapsedMs / 180))
  return from + (to - from) * (1 - (1 - progress) ** 3)
}

export function validateBands(bands: readonly ChapterBand[]): boolean {
  return (
    bands.length > 0 &&
    bands.every(
      (band, i) =>
        [band.start, band.end, band.top, band.bottom].every(Number.isFinite) &&
        band.end > band.start &&
        band.bottom > band.top &&
        (i === 0 || (band.top >= bands[i - 1]!.bottom && band.start === bands[i - 1]!.end))
    )
  )
}

/** Pure native-scroll mapping. Reversing direction does not reset a chapter. */
export function sampleScroll(y: number, bands: readonly ChapterBand[]): WorldSample {
  if (!bands.length) throw new Error("Chapter geometry is empty")
  const found = bands.findIndex((candidate) => y < candidate.bottom)
  const index = found < 0 ? bands.length - 1 : found
  const band = bands[index]!
  const width = band.bottom - band.top
  const fraction = Math.max(0, Math.min(1, (y - band.top) / width))
  const slope = (entry: ChapterBand) => (entry.end - entry.start) / (entry.bottom - entry.top)
  const rate = slope(band)
  const blend = (neighbor: ChapterBand | undefined) =>
    neighbor ? (2 * rate * slope(neighbor)) / (rate + slope(neighbor)) : rate
  // Monotone Hermite interpolation shares a tangent at each chapter boundary.
  // A short chapter no longer creates an instantaneous camera-speed increase.
  const startRate = blend(bands[index - 1])
  const endRate = blend(bands[index + 1])
  const t2 = fraction * fraction
  const t3 = t2 * fraction
  const time =
    (2 * t3 - 3 * t2 + 1) * band.start +
    (t3 - 2 * t2 + fraction) * width * startRate +
    (-2 * t3 + 3 * t2) * band.end +
    (t3 - t2) * width * endRate
  return { chapter: band.id, time }
}
