import type {
  JournalPort,
  SandboxToolRequest,
  ScanAuthorityContext,
  ScanAuthorityFence,
  SandboxToolExecDescriptor,
} from "@lyrashield/runtime-control"
import type { createScanSandboxToolIntentProducer } from "@lyrashield/db/src/scan-sandbox-tool-intent"
import type { SandboxToolAcknowledgements } from "./sandbox-tool-ack"
import type { createSandboxToolCapabilityVerifier } from "./sandbox-tool-capability"
import type { SandboxToolExecRunner, SandboxToolRequestAuthority } from "./sandbox-tool-http"
import type { SandboxToolJournal } from "./sandbox-tool-journal"
import type { SupervisorJournalEvent } from "./journal-events"

export type Credential = { token: string; attemptId: string; sandboxHandle: string }
export type SandboxToolRunnerOptions = {
  verifyCapability: ReturnType<typeof createSandboxToolCapabilityVerifier>
  intents: ReturnType<typeof createScanSandboxToolIntentProducer>
  context: ScanAuthorityContext
  fence: ScanAuthorityFence
  journal: SandboxToolJournal
  recordNativeStart: (
    event: SupervisorJournalEvent
  ) => ReturnType<JournalPort<SupervisorJournalEvent>["append"]>
  supervisorInstanceId: string
  acknowledgements: SandboxToolAcknowledgements
  consumeReceipts: (operationId: string) => Promise<unknown>
}
export type SandboxToolRunner = {
  authority: SandboxToolRequestAuthority
  runner: SandboxToolExecRunner
  operations: {
    readPty: (
      credential: Credential,
      input: {
        sessionId: number
        outputCursor: number
        maxOutputBytes: number
        yieldTimeSeconds: number
      }
    ) => Promise<unknown>
    stop: (
      credential: Credential,
      input: { binding: SandboxToolRequest["binding"]; requestId: string }
    ) => Promise<unknown>
    executePty: (
      credential: Credential,
      request: SandboxToolRequest,
      pty: SandboxToolExecDescriptor["pty"]
    ) => Promise<unknown>
    executeMutation: (
      credential: Credential,
      request: SandboxToolExecDescriptor["request"],
      kind: "pty/stdin" | "pty/terminate",
      pty: SandboxToolExecDescriptor["pty"]
    ) => Promise<unknown>
  }
}
