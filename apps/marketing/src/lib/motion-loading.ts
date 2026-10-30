export interface MotionConnection extends EventTarget {
  saveData?: boolean
  effectiveType?: string
  downlink?: number
}

/** Unknown network quality requires an explicit play request. */
export function canAutoLoadMotion(
  connection?: Pick<MotionConnection, "saveData" | "effectiveType" | "downlink">
) {
  return (
    !connection?.saveData &&
    connection?.effectiveType === "4g" &&
    typeof connection.downlink === "number" &&
    Number.isFinite(connection.downlink) &&
    connection.downlink >= 5
  )
}

export function chapterProgress(index: number, count: number) {
  return `${String(index + 1).padStart(2, "0")} / ${String(count).padStart(2, "0")}`
}
