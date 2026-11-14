// Container healthcheck for the controller images: unauthenticated liveness over
// the private unix socket the service already listens on. The socket path is per
// role, so the image passes it as the first argument.
import { request } from "node:http"

const socketPath = process.argv[2]
if (!socketPath) {
  process.stderr.write("controller healthcheck requires a socket path\n")
  process.exit(1)
}

const probe = request({ socketPath, path: "/healthz", method: "GET" }, (response) => {
  let body = ""
  response.setEncoding("utf8")
  response.on("data", (chunk) => (body += chunk))
  response.on("end", () => {
    if (response.statusCode !== 200) return process.exit(1)
    try {
      process.exitCode = JSON.parse(body)?.status === "ok" ? 0 : 1
    } catch {
      process.exitCode = 1
    }
  })
})
probe.setTimeout(4000, () => probe.destroy(new Error("timeout")))
probe.on("error", () => process.exit(1))
probe.end()
