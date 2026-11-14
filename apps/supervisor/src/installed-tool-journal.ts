import { AsyncLocalStorage } from "node:async_hooks"
import pg from "pg"
import { z } from "zod"
import {
  IndependentAuthorityJournal,
  SignedJournal,
  PostgresAuthorityMirror,
  authorityEventSchema,
  createConfiguredJournalStore,
  deriveSupervisorToolJournalIdentity,
  verifyJournalRecord,
  type ScanAuthorityContext,
  type JournalRecord,
} from "@lyrashield/runtime-control"
import { createScanSupervisorToolJournalAuthority } from "@lyrashield/db/src/scan-supervisor-tool-journal-authority"
import type { SupervisorReceiptAuthority } from "@lyrashield/db/src/scan-supervisor-receipt-ingestion-verifier"
import { SandboxToolJournal, sandboxToolEventSchema } from "./sandbox-tool-journal"
import { SandboxToolResponses } from "./sandbox-tool-response"
import { SandboxToolAcknowledgements } from "./sandbox-tool-ack"
import { rootSandboxToolTerminalObserver } from "./sandbox-tool-native"
import { validateSandboxToolOutput } from "./sandbox-tool-terminal"
import type { SupervisorAuthorityJournal } from "./authority-journal"
import { inspectJournalPath, journalPathsOverlap } from "./journal-paths"

function unavailable(): never {
  throw new Error("Protected independent tool journal is unavailable")
}

/** Receives only the main loader's already-validated private mirror pool. */
export async function createInstalledSupervisorToolJournal(options: {
  pool: pg.Pool
  mirrorPool: pg.Pool
  context: ScanAuthorityContext
  controller: SupervisorReceiptAuthority
  mainJournal: SupervisorAuthorityJournal
  originalPath: string
  independentPath: string
  storageJson: string
  readOnly?: boolean
}) {
  const identity = deriveSupervisorToolJournalIdentity({
    streamId: options.controller.streamId,
    authorityEpochId: options.controller.authorityEpochId,
    supervisorInstanceId: options.controller.supervisorInstanceId,
    originalSigningSecret: options.controller.originalSigningSecret,
    wrapperSigningSecret: options.controller.wrapperSigningSecret,
  })
  const paths = [
    options.originalPath,
    options.independentPath,
    `${options.originalPath}.tools`,
    `${options.independentPath}.tools`,
  ].map(inspectJournalPath)
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++)
      if (journalPathsOverlap(paths[i]!, paths[j]!)) unavailable()
  const mirror = new PostgresAuthorityMirror(
    options.mirrorPool,
    identity.authorityEpochId,
    identity.supervisorInstanceId
  )
  if (
    !(await mirror.verifySupervisorStreamBinding(
      identity.streamId,
      identity.originalKeyHash,
      identity.wrapperKeyHash
    ))
  )
    unavailable()
  const cleanup: Array<() => void | Promise<void>> = []
  try {
    const journalStorage = createConfiguredJournalStore(options.storageJson)
    cleanup.push(() => journalStorage.close())
    const responseStorage = createConfiguredJournalStore(options.storageJson, 4 * 1024 * 1024)
    cleanup.push(() => responseStorage.close())
    const responses = new SandboxToolResponses(responseStorage.store, identity.responseSecret)
    const originalSchema = z
      .unknown()
      .transform((value) =>
        verifyJournalRecord(value, identity.originalSigningSecret, sandboxToolEventSchema.parse)
      )
    const source = new SignedJournal(
      paths[2]!.canonical,
      identity.originalSigningSecret,
      sandboxToolEventSchema.parse
    )
    cleanup.push(() => source.close())
    const wrapper = new SignedJournal(
      paths[3]!.canonical,
      identity.wrapperSigningSecret,
      authorityEventSchema(originalSchema).parse
    )
    cleanup.push(() => wrapper.close())
    const readScope = new AsyncLocalStorage<{ controller?: Promise<JournalRecord<unknown>[]> }>()
    const validators = createScanSupervisorToolJournalAuthority({
      pool: options.pool,
      context: options.context,
      controller: options.controller,
      identity,
      mirror,
      parseEvent: sandboxToolEventSchema.parse,
      readControllerHistory: () => {
        const scope = readScope.getStore()
        if (!scope) unavailable()
        // One fresh authenticated controller snapshot per tool-journal operation;
        // each old wrapper/ACK and each live action still receives its own checks.
        scope.controller ??= options.mainJournal.load()
        return scope.controller
      },
      verifyRetainedResponse: async (event, descriptor) => {
        if (!event.tool.responseChecksum || !event.tool.objectDigest) unavailable()
        const response = await responses.load(descriptor.request.binding, event.tool.requestId, {
          responseChecksum: event.tool.responseChecksum,
          objectDigest: event.tool.objectDigest,
        })
        validateSandboxToolOutput(response, event)
      },
    })
    const independent = new IndependentAuthorityJournal({
      local: wrapper,
      store: journalStorage.store,
      mirror,
      epochId: identity.authorityEpochId,
      supervisorInstanceId: identity.supervisorInstanceId,
      signingSecret: identity.wrapperSigningSecret,
      payloadSchema: originalSchema,
      authorize: options.readOnly ? async () => false : validators.authorize,
      authorizeConfirmed: validators.authorizeConfirmed,
    })
    const journal = new SandboxToolJournal(
      source,
      independent,
      identity.originalSigningSecret,
      identity.authorityEpochId,
      identity.supervisorInstanceId,
      identity.ownerSupervisorInstanceId,
      {
        authorizeStream: validators.authorizeStream,
        authorizeAppend: options.readOnly ? async () => false : validators.authorizeAppend,
        readOnly: options.readOnly,
        readOperation: (operation) => readScope.run({}, operation),
        publicationWrapper: {
          load: () => wrapper.load(),
          readRange: (after, limits) => wrapper.readRange(after, limits),
          readRawRange: (after, limits) => wrapper.readRawRange(after, limits),
        },
      }
    )
    await journal.load()
    return {
      toolJournal: journal,
      toolResponses: responses,
      toolAcknowledgements: new SandboxToolAcknowledgements(
        journal,
        responses,
        rootSandboxToolTerminalObserver
      ),
      close: async () => {
        await Promise.allSettled(cleanup.map((close) => close()))
      },
    }
  } catch {
    await Promise.allSettled(cleanup.map((close) => close()))
    unavailable()
  }
}
