/**
 * Broker-shaped receipt helpers (supervisor side).
 *
 * Canonical receipt recipe — must match the broker verifier in
 * `packages/db/src/scan-supervisor-receipt-verifier.ts` exactly:
 * - `hash = sha256Hex(canonicalJson({version, sequence, previousHash, payload}))`
 * - `signature = HMAC-SHA256(secret, canonicalJson({version, sequence,
 *   previousHash, payload, hash}))` hex
 * where `canonicalJson` sorts object keys recursively then stringifies.
 * The supervisor instance id is inside `payload`, so the hash commits to it;
 * the returned receipt also carries it top-level for mirroring.
 */
import { canonicalJson, sha256Hex } from "./canonical-json"
import type { BrokerReceiptType } from "./protocol"

export const SUPERVISOR_RECEIPT_DOMAIN = "lyrashield-supervisor-receipt/1"
export const SUPERVISOR_RECEIPT_VERSION = 1
export const SUPERVISOR_RECEIPT_CANONICAL_FIELDS = [
  "version",
  "sequence",
  "previousHash",
  "payload",
  "hash",
] as const

/**
 * Journal-event → broker receipt type mapping.
 *
 * | Journal event             | Broker receipt type        | Notes |
 * | ------------------------- | -------------------------- | ----- |
 * | `attempt_prepared`        | `PREPARE_COMPLETED`        | Drives `PREPARED` once the broker `PREPARE` command is `COMPLETED`. |
 * | `command_intent`          | `COMMAND_ACCEPTED`         | Command type (`PREPARE`/`START_*`/`STOP`) distinguishes the physical transition. |
 * | `resource_create_planned` | `EXECUTOR_CREATE_INTENT`   | Carries `executorKey`; drives `DISPATCH_PENDING`. |
 * | `resource_bound`          | `UNKNOWN`                  | Created ownership is not proof of execution. |
 * | `resource_started`        | `EXECUTOR_STARTED`         | Issued only after executor start returns successfully. |
 * | `provider_grants_bound`   | `UNKNOWN`                  | No broker physical event; mirroring must ignore or quarantine. |
 * | `provider_grants_revoked` | `UNKNOWN`                  | Mirroring may upgrade to `STOPPED` only when the executor is proven `ABSENT` (see audit #11). |
 * | `attempt_status`          | `UNKNOWN`                  | Mirroring must ignore; `command_terminal` carries the actionable status. |
 * | `command_terminal` STOPPED | `STOPPED`               | Drives `CLEANUP_PENDING`/`STOPPED`. |
 * | `command_terminal` NEVER_DISPATCHED | `NEVER_DISPATCHED` | Drives `NEVER_DISPATCHED`. |
 * | `command_terminal` UNKNOWN | `UNKNOWN`               | Quarantines to `UNKNOWN`; resolve via `RECONCILE`. |
 * | `command_terminal` other  | `UNKNOWN`                  | Mirroring must interpret journal event types and avoid turning non-authoritative administrative events into state transitions. |
 */
export function toBrokerReceiptType(event: { type: string; status?: string }): BrokerReceiptType {
  switch (event.type) {
    case "attempt_prepared":
      return "PREPARE_COMPLETED"
    case "command_intent":
      return "COMMAND_ACCEPTED"
    case "resource_create_planned":
      return "EXECUTOR_CREATE_INTENT"
    case "resource_started":
      return "EXECUTOR_STARTED"
    case "command_terminal": {
      if (event.status === "STOPPED") return "STOPPED"
      if (event.status === "NEVER_DISPATCHED") return "NEVER_DISPATCHED"
      return "UNKNOWN"
    }
    default:
      return "UNKNOWN"
  }
}

/**
 * Evidence digest for a journal payload: `sha256Hex(canonicalJson(payload))`.
 * The payload here is the full journal event (including
 * `supervisorInstanceId` and `observedAt`); because `evidenceDigest` itself
 * lives only on the returned receipt, there is no self-reference.
 */
export function computeEvidenceDigest(payload: unknown): string {
  return sha256Hex(canonicalJson(payload))
}
