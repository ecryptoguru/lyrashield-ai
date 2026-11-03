import http from "node:http"
import { writeFileSync } from "node:fs"

const [portFile, mode, stopFile] = process.argv.slice(2)
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  if (req.url === "/api/ready") {
    res.statusCode = mode === "api-outage" ? 503 : 200
    res.end(JSON.stringify({ status: "ready", checks: { database: true, redis: true } }))
  } else if (req.url === "/api/ready/scans") {
    if (mode === "http-replacement")
      writeFileSync(stopFile, '{"operator":"on-call","reason":"http-fixture"}')
    if (mode === "http-removal") writeFileSync(stopFile, "")
    res.statusCode = mode === "scans-open" ? 200 : 503
    res.end(
      mode === "malformed-body"
        ? "unrelated outage"
        : JSON.stringify({
            status: mode === "scans-healthy-body" ? "ready" : "not_ready",
            checks: { worker: false },
          })
    )
  } else {
    res.statusCode = 404
    res.end("{}")
  }
})
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)))
process.on("SIGTERM", () => server.close())
setTimeout(() => server.close(), 30000).unref()
