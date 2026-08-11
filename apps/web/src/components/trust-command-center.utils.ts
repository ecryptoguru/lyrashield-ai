export function commandCenterFirstMetric(assetCount: number): "next-step" | "estimate" {
  return assetCount === 0 ? "next-step" : "estimate"
}

export function dashboardPrimaryAction(targetCount: number): { href: string; label: string } {
  return targetCount === 0
    ? { href: "/dashboard/targets", label: "Add a target" }
    : { href: "/dashboard/scans?new=1", label: "Start a scan" }
}
