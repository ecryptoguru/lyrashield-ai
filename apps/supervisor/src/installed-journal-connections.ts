function unavailable(): never {
  throw new Error("Protected independent supervisor journal is unavailable")
}

/** Keep mirror and receipt roles distinct within the checked execution database. */
export function installedJournalMirrorRole(
  mirrorUrl: string,
  executionUrl: string,
  receiptUrl?: string
): string {
  try {
    const url = new URL(mirrorUrl),
      execution = new URL(executionUrl)
    const receipt = receiptUrl ? new URL(receiptUrl) : undefined
    const mirrorRole = decodeURIComponent(url.username)
    if (
      !/^postgres(?:ql)?:$/.test(url.protocol) ||
      !/^[a-z][a-z0-9_]{2,62}$/.test(mirrorRole) ||
      ["postgres", "service_role", "app_runtime_prod", "app_system_prod"].includes(mirrorRole) ||
      decodeURIComponent(execution.username) === mirrorRole ||
      url.hostname !== execution.hostname ||
      (url.port || "5432") !== (execution.port || "5432") ||
      url.pathname !== execution.pathname ||
      (receipt !== undefined &&
        (!/^postgres(?:ql)?:$/.test(receipt.protocol) ||
          !/^[a-z][a-z0-9_]{2,62}$/.test(decodeURIComponent(receipt.username)) ||
          [
            mirrorRole,
            decodeURIComponent(execution.username),
            "postgres",
            "service_role",
            "app_runtime_prod",
            "app_system_prod",
          ].includes(decodeURIComponent(receipt.username)) ||
          receipt.hostname !== execution.hostname ||
          (receipt.port || "5432") !== (execution.port || "5432") ||
          receipt.pathname !== execution.pathname))
    )
      unavailable()
    return mirrorRole
  } catch {
    unavailable()
  }
}
