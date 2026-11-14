import type pg from "pg"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"

export async function bindScanPreparationContext(client: pg.PoolClient, operationId: string) {
  const row = (
    await client.query<{ workspaceId: string; accountId: string; userId: string }>(
      "SELECT * FROM app.scan_preparation_context($1)",
      [operationId]
    )
  ).rows[0]
  if (!row)
    throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Operation context unavailable")
  await client.query(
    "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id',$2,true),set_config('app.current_scan_user_id',$3,true)",
    [row.workspaceId, row.accountId, row.userId]
  )
}
