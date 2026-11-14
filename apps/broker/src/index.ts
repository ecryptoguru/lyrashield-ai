import { createServer } from "node:http"
import { listenPrivateControlServer } from "@lyrashield/runtime-control"
import { loadBrokerConfig } from "./config"
import { createBrokerHandler } from "./http"
import { createBrokerService } from "./service"

const config = loadBrokerConfig()
const service = createBrokerService(config)
const server = createServer(createBrokerHandler(service, config.controlToken))
const ready = () => {
  process.stdout.write(
    JSON.stringify({
      service: "lyrashield-broker",
      status: "ready",
      admission: service.admission,
      receipts: config.receiptAuthority ? "installed" : "closed",
    }) + "\n"
  )
}
if (config.transport.kind === "unix") {
  await listenPrivateControlServer(server, config.transport.socketPath)
  ready()
} else {
  server.listen(config.transport.port, config.transport.host, ready)
}
let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  const deadline = setTimeout(() => process.exit(1), 20_000)
  server.close(() => {
    void service
      .close()
      .then(() => {
        clearTimeout(deadline)
        process.exit(0)
      })
      .catch(() => process.exit(1))
  })
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
