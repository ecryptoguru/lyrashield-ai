import {
  AuthorityFenceError,
  authorityActionSchema,
  canonicalJson,
  type AuthorityAction,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"

import {
  createScanExecutionActionAuthorityVerifier,
  type ScanExecutionActionPolicy,
} from "./scan-execution-action-intent"

/** The caller owns a READ COMMITTED, READ ONLY connection from protected root config. */
export function createScanNativeOriginAuthorityVerifier(options: ScanExecutionActionPolicy) {
  const verifyCurrent = createScanExecutionActionAuthorityVerifier(options)
  return async (
    connection: AuthoritySqlConnection,
    input: AuthorityAction,
    guardId: string
  ): Promise<{ deadlineAt: Date }> => {
    const binding = authorityActionSchema.parse(input)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(guardId) || guardId.includes(".."))
      throw new AuthorityFenceError()
    await connection.query("SELECT app.require_scan_native_origin_reader()", [])
    const original = (
      await connection.query("SELECT * FROM app.read_scan_native_origin_guard($1)", [guardId])
    ).rows
    if (
      original.length !== 1 ||
      original[0]?.bindingInputJson !== canonicalJson(binding) ||
      !(original[0]?.deadlineAt instanceof Date) ||
      !Number.isFinite(original[0].deadlineAt.getTime())
    )
      throw new AuthorityFenceError()
    await connection.query("SELECT set_config('app.native_origin_guard_id',$1,true)", [guardId])

    // Only the canonical verifier receives this private adapter. Its source,
    // signature, policy and tenancy queries are unchanged; SQL proves the live
    // originating gate rather than returning a fabricated own-session result.
    const checked: AuthoritySqlConnection = {
      query(text, values = []) {
        if (text === "SELECT app.require_scan_execution_action_role()")
          return connection.query("SELECT app.require_scan_native_origin_reader()", values)
        if (!text.includes("app.scan_preparation_gate_held()"))
          return connection.query(text, values)
        const bound = [...values, guardId]
        return connection.query(
          text.replaceAll(
            "app.scan_preparation_gate_held()",
            `app.scan_native_executor_origin_gate_held($${bound.length})`
          ),
          bound
        )
      },
      release() {
        throw new AuthorityFenceError()
      },
    }
    const current = await verifyCurrent(checked, binding)
    const final = (
      await connection.query("SELECT * FROM app.read_scan_native_origin_guard($1)", [guardId])
    ).rows
    if (
      final.length !== 1 ||
      final[0]?.bindingInputJson !== canonicalJson(binding) ||
      !(final[0]?.deadlineAt instanceof Date)
    )
      throw new AuthorityFenceError()
    const deadlineAt = new Date(
      Math.min(
        current.deadlineAt.getTime(),
        original[0].deadlineAt.getTime(),
        final[0].deadlineAt.getTime()
      )
    )
    if (!Number.isFinite(deadlineAt.getTime())) throw new AuthorityFenceError()
    return { deadlineAt }
  }
}
