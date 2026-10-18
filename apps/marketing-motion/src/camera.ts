export type WorldVariant = "desktop" | "portrait"
export interface CameraSample {
  position: readonly [number, number, number]
  target: readonly [number, number, number]
  fov: number
}
const smoother = (value: number) => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** One continuous forward take. Sampling has no frame-history dependence. */
export function sampleCamera(time: number, variant: WorldVariant): CameraSample {
  const p = Math.max(0, Math.min(1, time / 56))
  const portrait = variant === "portrait"
  const entrance = 1 - smoother(p / 0.22)
  const finish = smoother((p - 0.8) / 0.2)
  const arc = Math.sin(p * Math.PI * 4)
  const orbit = Math.cos(p * Math.PI * 2)
  const push = Math.sin(p * Math.PI) ** 2
  // Cross the folio's axis in one continuous take, then settle for the report.
  const x = portrait
    ? (2.2 * orbit + 0.6 * arc) * (1 - finish) + 0.15 * finish
    : (5.2 * orbit + 1.4 * arc) * (1 - finish) + 0.5 * finish + 0.4 * entrance
  const y = portrait
    ? 4.7 + 0.35 * Math.sin(p * Math.PI * 2) + 0.15 * arc - 0.18 * finish
    : 3.6 + Math.sin(p * Math.PI * 2) + 0.25 * arc + 0.8 * entrance - 0.35 * finish
  const depth = portrait ? 9.5 + 2.5 * entrance - push : 9 + 4 * entrance - 1.8 * push
  const z = 1 - 84 * p + depth
  // Track the traveling record while leaving room for real HTML copy.
  const yaw = Math.atan2(-x, depth) - (portrait ? 0 : Math.PI / 15)
  const targetX = x + Math.tan(yaw) * 9
  const pitch =
    Math.atan2(2.25 - y, Math.hypot(x, depth)) - (portrait ? Math.PI / 15 : Math.PI / 90)
  const targetY = y + Math.tan(pitch) * Math.hypot(targetX - x, 9)
  return {
    position: [x, y, z],
    target: [targetX, targetY, z - 9],
    fov: portrait ? 48 : 42 - 1.8 * push,
  }
}
