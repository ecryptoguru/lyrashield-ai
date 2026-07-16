export function getTrendPointX(
  index: number,
  pointCount: number,
  width: number,
  inset: number
): number {
  if (pointCount <= 1) return width / 2
  return inset + (index / (pointCount - 1)) * (width - inset * 2)
}
