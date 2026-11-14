import { createServer } from "node:http"
import { SignedJournal, listenPrivateControlServer } from "@lyrashield/runtime-control"
import { loadSupervisorConfig } from "./config"
import { loadDatabaseSupervisorAuthority } from "./database-authority"
import { DockerRuntimeExecutor, LinuxProcessExecutor } from "./executor"
import { createSupervisorHandler } from "./http"
import { ProviderGatewayClient } from "./provider-client"
import { SupervisorService, supervisorJournalEventSchema } from "./service"

const config = loadSupervisorConfig()
const authority = loadDatabaseSupervisorAuthority(config)
const journal = new SignedJournal(config.journalPath, config.signingSecret, (value) =>
  supervisorJournalEventSchema.parse(value)
)
const containerExecutor = new DockerRuntimeExecutor()
const processExecutor = new LinuxProcessExecutor(config.policy.allowedCgroupRoot)
const executor = {
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
const server = createServer(
  createSupervisorHandler(service, {
    controlToken: config.controlToken,
    admission: config.admission,
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
    await Promise.all([journal.close(), authority?.close()])
    clearTimeout(deadline)
    process.exit(0)
  })().catch(() => process.exit(1))
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
