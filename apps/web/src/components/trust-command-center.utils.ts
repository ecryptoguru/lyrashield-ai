export function commandCenterFirstMetric(assetCount: number): "next-step" | "estimate" {
  return assetCount === 0 ? "next-step" : "estimate"
}
