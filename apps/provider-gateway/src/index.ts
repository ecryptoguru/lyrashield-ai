import { createServer } from "node:http"
import { SignedJournal, listenPrivateControlServer } from "@lyrashield/runtime-control"
import { loadProviderGatewayConfig } from "./config"
import { loadDatabaseProviderAuthority } from "./database-installation"
import { createProviderGatewayHandler } from "./http"
import { ProviderGatewayService, providerJournalEventSchema } from "./service"

const config = loadProviderGatewayConfig()
const authority = loadDatabaseProviderAuthority(config.providers)
const journal = new SignedJournal(config.journalPath, config.signingSecret, (value) =>
  providerJournalEventSchema.parse(value)
)
const service = new ProviderGatewayService({
  ...authority,
  journal,
  signingSecret: config.signingSecret,
  responseEncryptionSecret: config.responseEncryptionSecret,
  admission: config.admission,
  providers: config.providers,
})
await service.initialize()
const server = createServer(
  createProviderGatewayHandler(service, {
    controlToken: config.controlToken,
    admission: config.admission,
  })
)
const ready = () => {
  process.stdout.write(
    JSON.stringify({
      service: "lyrashield-provider-gateway",
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
    await journal.close()
    await authority?.close()
    clearTimeout(deadline)
    process.exit(0)
  })().catch(() => process.exit(1))
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
