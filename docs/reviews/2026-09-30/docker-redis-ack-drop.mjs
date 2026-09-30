// Disposable Redis fault injection only. Forward the Lua effect; lose one acknowledgement.
import { connect, createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"

const mode = process.env.FIXTURE_FAULT_MODE ?? "lost-ack"
if (!["lost-ack", "absent"].includes(mode)) throw new Error("Unknown fixture mode")
const marker = '"goal":"TEST_APP"'
const sockets = new Set()
const receipt = {
  mode,
  applied: false,
  scanId: null,
  acknowledgementsDropped: 0,
  noscriptForwarded: 0,
}
createServer((client) => {
  const backend = connect(6379, "redis")
  sockets.add(client)
  sockets.add(backend)
  let pending = Buffer.alloc(0)
  let suppress = false
  let response = Buffer.alloc(0)
  client.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]).subarray(-65_536)
    const text = pending.toString()
    if (!receipt.applied && text.includes(marker)) {
      const scanId = text.match(/"scanId":"([a-zA-Z0-9_-]+)"/)?.[1]
      if (scanId) {
        suppress = true
        receipt.scanId = scanId
        if (mode === "absent") {
          receipt.applied = true
          console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...receipt }))
          client.destroy()
          backend.destroy()
          return
        }
      }
    }
    backend.write(chunk)
  })
  backend.on("data", (chunk) => {
    if (!suppress) {
      client.write(chunk)
      return
    }
    response = Buffer.concat([response, chunk])
    if (!response.includes(Buffer.from("\r\n"))) return
    // The client must receive NOSCRIPT so it can send the full Lua program.
    if (response.toString().startsWith("-NOSCRIPT")) {
      receipt.noscriptForwarded++
      client.write(response)
      response = Buffer.alloc(0)
      return
    }
    receipt.applied = true
    receipt.acknowledgementsDropped++
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...receipt }))
    response = Buffer.alloc(0)
  })
  client.on("error", () => backend.destroy())
  backend.on("error", () => client.destroy())
  client.on("close", () => {
    sockets.delete(client)
    backend.destroy()
  })
  backend.on("close", () => {
    sockets.delete(backend)
    client.destroy()
  })
}).listen(6379, "0.0.0.0")
createHttpServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ ...receipt, connections: sockets.size }))
}).listen(8080, "0.0.0.0")
