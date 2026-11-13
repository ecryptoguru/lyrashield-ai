import type { Dispatch, SetStateAction } from "react"
import { findRecoveryPreset, scanRecoveryHref } from "./scans-client.utils"
import { getDefaultScanOptionId, getManualScanOptions } from "@/lib/scan-presets"
import type { ScanItem, TargetItem } from "./scan-types"

export function prepareScanRetry(
  scan: ScanItem,
  args: {
    targets: TargetItem[]
    setSelectedTarget: Dispatch<SetStateAction<string>>
    choosePreset: (id: string) => void
    setBaseRef: Dispatch<SetStateAction<string>>
    setHeadRef: Dispatch<SetStateAction<string>>
    setSelectedFocus: Dispatch<SetStateAction<string | null>>
    setSelectedAttachments: Dispatch<SetStateAction<string[]>>
    setError: Dispatch<SetStateAction<string | null>>
    setModeResetNotice: Dispatch<SetStateAction<string | null>>
    setShowCreate: Dispatch<SetStateAction<boolean>>
  }
) {
  const target = args.targets.find((item) => item.id === scan.target?.id)
  if (!target) {
    if (scan.target)
      window.location.assign(
        scanRecoveryHref({ targetId: scan.target.id, goal: scan.goal, mode: scan.mode })
      )
    else
      args.setError("This target is no longer available. Choose another target to run a new scan.")
    return
  }
  const options = getManualScanOptions({
    type: target.type,
    hasApiSpec: Boolean(target.apiSpecUrl),
  })
  const preset = findRecoveryPreset(options, scan.goal, scan.mode)
  args.setSelectedTarget(target.id)
  args.choosePreset(preset || getDefaultScanOptionId(options))
  args.setBaseRef("")
  args.setHeadRef("")
  args.setSelectedFocus(null)
  args.setSelectedAttachments([])
  args.setError(null)
  args.setModeResetNotice(
    preset ? null : "The previous review type is unavailable. Choose an available option."
  )
  args.setShowCreate(true)
}
