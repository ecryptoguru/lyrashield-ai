import {
  AuthorityFenceError,
  authorityActionSchema,
  canonicalJson,
  type AuthorityAction,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import { authenticateRetainedSupervisorHistoryBytes } from "./scan-supervisor-authority-source-verifier"
import {
  checkReceiptKeys,
  verifyHead,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"

function checkedGuard(input: AuthorityAction, guardId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(guardId) || guardId.includes(".."))
    throw new AuthorityFenceError()
  return authorityActionSchema.parse(input)
}

/** Only the root ledger supplies the original binding; expiry never proves removal. */
export async function readScanNativeRetainedGuard(
  connection: AuthoritySqlConnection,
  input: AuthorityAction,
  guardId: string
) {
  const action = checkedGuard(input, guardId)
  await connection.query("SELECT app.require_scan_native_origin_reader()", [])
  const rows = (
    await connection.query("SELECT * FROM app.read_scan_native_retained_guard($1)", [guardId])
  ).rows
  if (rows.length !== 1 || rows[0]?.bindingInputJson !== canonicalJson(action))
    throw new AuthorityFenceError()
  return action
}

/** Authenticate original and independent wrapper signatures before accepting the stored STOP. */
export async function readScanNativeRetirementGuard(
  connection: AuthoritySqlConnection,
  input: AuthorityAction,
  guardId: string,
  authority: SupervisorReceiptAuthority
) {
  const action = checkedGuard(input, guardId)
  await connection.query("SELECT app.require_scan_native_origin_reader()", [])
  const rows = (
    await connection.query("SELECT * FROM app.read_scan_native_retirement_guard($1)", [guardId])
  ).rows
  const row = rows[0]
  if (
    rows.length !== 1 ||
    !row ||
    row.bindingInputJson !== canonicalJson(action) ||
    row.streamId !== authority.streamId ||
    action.authorityEpochId !== authority.authorityEpochId
  )
    throw new AuthorityFenceError()
  checkReceiptKeys(authority)
  const command = readStoredDispatchCommand(
    String(row.commandInputJson),
    String(row.commandInputChecksum)
  )
  const signed = authenticateRetainedSupervisorHistoryBytes(
    {
      originalInputJson: String(row.originalInputJson),
      wrapperInputJson: String(row.wrapperInputJson),
    },
    authority
  )
  const head = verifyHead(JSON.parse(String(row.headInputJson)), authority)
  if (
    !command ||
    command.type !== "STOP" ||
    command.attemptId !== action.attemptId ||
    signed.original.payload.type !== "command_intent" ||
    canonicalJson(signed.original.payload.command) !== row.commandInputJson ||
    signed.wrapper.payload.operationId !== action.operationId ||
    signed.wrapper.payload.attemptId !== action.attemptId ||
    signed.wrapper.payload.scanId !== action.scanId ||
    signed.wrapper.payload.workspaceId !== action.workspaceId ||
    String(signed.wrapper.sequence) !== row.sourceSequence ||
    head.sequence !== Number(row.confirmedSequence) ||
    signed.wrapper.sequence > head.sequence
  )
    throw new AuthorityFenceError()
  return command
}
