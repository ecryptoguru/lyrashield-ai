import { createInstalledDispatchCommandReader } from "./dispatch-command"
import { createScanDispatchLifecycleProofRegistrar } from "@lyrashield/db/src/scan-dispatch-lifecycle-proof-registrar"
import { createScanSandboxToolIntentProducer } from "@lyrashield/db/src/scan-sandbox-tool-intent"
import { createServer } from "node:http"
import {
  SignedJournal,
  listenPrivateControlServer,
  supervisorAttemptProofPublicKey,
  validateSupervisorAttemptProofPublicKey,
} from "@lyrashield/runtime-control"
import { loadSupervisorConfig } from "./config"
import { loadDatabaseSupervisorAuthority } from "./database-authority"
import { loadInstalledSupervisorJournal } from "./installed-journal"
import { createSupervisorAttemptProofIssuer } from "./attempt-proof"
import { DockerRuntimeExecutor, LinuxProcessExecutor } from "./executor"
import { RootNativeRuntimeExecutor, requestNativeExecutor } from "./native-executor-client"
import { createSupervisorNativeResultReader } from "./native-result"
import { createSupervisorHandler } from "./http"
import { ProviderGatewayClient } from "./provider-client"
import { SupervisorService, supervisorJournalEventSchema } from "./service"
import { createSandboxToolCapabilityVerifier } from "./sandbox-tool-capability"
import { createSandboxToolRunner } from "./sandbox-tool-runner"
import { createSandboxToolHandler } from "./sandbox-tool-http"
import { createSandboxToolPtyHandler } from "./sandbox-tool-pty"

const config = loadSupervisorConfig()
const authority = loadDatabaseSupervisorAuthority(config)
const installedJournal = await loadInstalledSupervisorJournal(config, authority)
const localJournal = installedJournal
  ? undefined
  : new SignedJournal(config.journalPath, config.signingSecret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
const journal = installedJournal?.journal ?? localJournal!
let scopedControlToken: string | undefined
let attemptProofPrivateKey: string | undefined
if (installedJournal && authority) {
  scopedControlToken = process.env.LYRASHIELD_SUPERVISOR_BROKER_CONTROL_TOKEN
  if (
    !scopedControlToken ||
    scopedControlToken.length < 32 ||
    scopedControlToken === config.controlToken ||
    /[\r\n]/.test(scopedControlToken)
  )
    throw new Error("Protected scoped supervisor credential is unavailable")
  attemptProofPrivateKey = process.env.LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PRIVATE_KEY
  const publicPin = process.env.LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PUBLIC_KEY
  if (
    !attemptProofPrivateKey ||
    !publicPin ||
    supervisorAttemptProofPublicKey(attemptProofPrivateKey) !==
      validateSupervisorAttemptProofPublicKey(publicPin)
  )
    throw new Error("Protected attempt proof identity is unavailable")
}
const proofRegistrar =
  installedJournal && authority
    ? await createScanDispatchLifecycleProofRegistrar(
        process.env.LYRASHIELD_SUPERVISOR_PROOF_DATABASE_URL ?? ""
      )
    : undefined
const containerExecutor = authority
  ? new RootNativeRuntimeExecutor(authority.context)
  : new DockerRuntimeExecutor()
const processExecutor = new LinuxProcessExecutor(config.policy.allowedCgroupRoot)
const legacyExecutor = {
  create: async (...args: Parameters<DockerRuntimeExecutor["create"]>) => {
    const spec = args[1]
    return spec.kind === "container"
      ? containerExecutor.create(...args)
      : processExecutor.create(...args)
  },
  start: async (...args: Parameters<DockerRuntimeExecutor["start"]>) => {
    const [ownership, spec, context] = args
    return spec.kind === "container"
      ? containerExecutor.start(ownership, spec, context)
      : processExecutor.start(ownership, spec, context)
  },
  inspect: async (ownership: Parameters<DockerRuntimeExecutor["inspect"]>[0]) =>
    ownership.kind === "container"
      ? containerExecutor.inspect(ownership)
      : processExecutor.inspect(ownership),
  stop: async (...args: Parameters<DockerRuntimeExecutor["stop"]>) =>
    args[0].kind === "container" ? containerExecutor.stop(...args) : processExecutor.stop(args[0]),
}
const executor = authority ? containerExecutor : legacyExecutor
const service = new SupervisorService({
  journal,
  executor,
  providerGateway: new ProviderGatewayClient(
    config.providerGatewayUrl,
    config.providerGatewayControlToken
  ),
  providerGatewayUrl: config.providerGatewayUrl,
  policy: config.policy,
  signingSecret: config.signingSecret,
  supervisorInstanceId: config.supervisorInstanceId,
  admission: config.admission,
  ...(authority ? { authorityFence: authority.authorityFence } : {}),
})
await service.initialize()
const tools = installedJournal && authority ? await installedJournal.createTools() : undefined
const toolIntents =
  tools && authority
    ? createScanSandboxToolIntentProducer({
        connectionString: authority.supervisorAuthority.connectionString,
        supervisorAuthority: authority.supervisorAuthority,
      })
    : undefined
const toolRunner =
  tools && authority && installedJournal
    ? createSandboxToolRunner({
        verifyCapability: createSandboxToolCapabilityVerifier({
          publicKeyPem: process.env.LYRASHIELD_SANDBOX_GRANT_PUBLIC_KEY ?? "",
          keyId: process.env.LYRASHIELD_SANDBOX_GRANT_KEY_ID ?? "",
          authorityEpochId: authority.supervisorAuthority.authorityEpochId,
        }),
        intents: toolIntents!,
        context: authority.context,
        fence: authority.authorityFence,
        journal: tools.toolJournal,
        recordNativeStart: (event) => service.recordSandboxNativeStart(event),
        supervisorInstanceId: authority.supervisorAuthority.supervisorInstanceId,
        acknowledgements: tools.toolAcknowledgements,
        consumeReceipts: installedJournal.consumeReceipts!,
      })
    : undefined
const server = createServer(
  createSupervisorHandler(service, {
    controlToken: config.controlToken,
    ...(scopedControlToken ? { scopedControlToken } : {}),
    admission: config.admission,
    ...(tools && toolRunner
      ? {
          sandboxToolHandler: createSandboxToolPtyHandler(
            toolRunner,
            createSandboxToolHandler(
              toolRunner.authority,
              tools.toolAcknowledgements,
              toolRunner.runner
            )
          ),
        }
      : {}),
    ...(installedJournal && authority
      ? {
          receiptConsumer: installedJournal.consumeReceipts,
          persistedCommandReader: createInstalledDispatchCommandReader(
            authority.pool,
            authority.supervisorAuthority.authorityEpochId
          ),
          nativeResultReader: createSupervisorNativeResultReader({
            journal: installedJournal.journal,
            epochId: authority.supervisorAuthority.authorityEpochId,
            supervisorInstanceId: authority.supervisorAuthority.supervisorInstanceId,
            consumeReceipts: installedJournal.consumeReceipts!,
            readNative: (ownership, offset) =>
              requestNativeExecutor({
                schema: 1,
                method: "result-read",
                ownership,
                offset,
                maxBytes: 1024 * 1024,
              }),
          }),
          attemptProofIssuer: createSupervisorAttemptProofIssuer({
            journal: installedJournal.journal,
            privateKey: attemptProofPrivateKey!,
            registerProof: proofRegistrar!.register,
            epochId: authority.supervisorAuthority.authorityEpochId,
            supervisorInstanceId: authority.supervisorAuthority.supervisorInstanceId,
          }),
        }
      : {}),
  })
)
const ready = () => {
  process.stdout.write(
    JSON.stringify({
      service: "lyrashield-supervisor",
      status: "ready",
      admission: config.admission,
    }) + "\n"
  )
}
if (config.socketPath) {
  await listenPrivateControlServer(server, config.socketPath)
  ready()
} else {
  server.listen(config.port, config.host, ready)
}
let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  const deadline = setTimeout(() => process.exit(1), 20_000)
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  void (async () => {
    await Promise.all([service.drain(), closed])
    await toolIntents?.close()
    await Promise.all([
      installedJournal ? installedJournal.close() : localJournal?.close(),
      authority?.close(),
      proofRegistrar?.close(),
    ])
    clearTimeout(deadline)
    process.exit(0)
  })().catch(() => process.exit(1))
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
