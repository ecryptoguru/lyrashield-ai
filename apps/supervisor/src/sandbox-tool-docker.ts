import { request } from "node:http"

// Only trusted supervisor composition constructs this transport. The socket
// path must never come from a tool request, an environment variable, or a grant.
export class SandboxToolDocker {
  constructor(private readonly socketPath = "/var/run/docker.sock") {}

  private async call(method: "GET" | "POST", path: string, input?: object): Promise<unknown> {
    const body = input ? Buffer.from(JSON.stringify(input)) : undefined
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path: `/v1.41${path}`,
          ...(body
            ? { headers: { "content-type": "application/json", "content-length": body.byteLength } }
            : {}),
          timeout: 5_000,
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > 64 * 1024) {
              req.destroy(new Error("Docker response is too large"))
              return
            }
            chunks.push(chunk)
          })
          response.on("error", reject)
          response.on("end", () => {
            if (response.statusCode !== 200 && response.statusCode !== 201) {
              reject(new Error("Docker action outcome unavailable"))
              return
            }
            try {
              const text = Buffer.concat(chunks).toString("utf8")
              resolve(text ? JSON.parse(text) : null)
            } catch {
              reject(new Error("Docker response is invalid"))
            }
          })
        }
      )
      req.on("timeout", () => req.destroy(new Error("Docker action timed out")))
      req.on("error", reject)
      req.end(body)
    })
  }

  async create(containerId: string, argv: string[], cwd: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("invalid retained container")
    const result = await this.call("POST", `/containers/${containerId}/exec`, {
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      Cmd: argv,
      User: "pentester",
      WorkingDir: cwd,
    })
    if (
      result === null ||
      typeof result !== "object" ||
      !/^[a-f0-9]{64}$/.test(String(Reflect.get(result, "Id")))
    )
      throw new Error("Docker exec identity unavailable")
    return String(Reflect.get(result, "Id"))
  }

  async start(execId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(execId)) throw new Error("invalid retained Docker exec identity")
    await this.call("POST", `/exec/${execId}/start`, { Detach: true, Tty: false })
  }

  async inspect(containerId: string, ownershipId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(containerId) || !/^own_[a-f0-9]{40}$/.test(ownershipId))
      throw new Error("invalid retained sandbox identity")
    const result = await this.call("GET", `/containers/${containerId}/json`)
    if (!result || typeof result !== "object") throw new Error("sandbox inspection unavailable")
    const config = Reflect.get(result, "Config")
    const state = Reflect.get(result, "State")
    const labels = config && typeof config === "object" ? Reflect.get(config, "Labels") : null
    if (
      Reflect.get(result, "Id") !== containerId ||
      !labels ||
      typeof labels !== "object" ||
      Reflect.get(labels, "lyrashield.supervisor.ownership") !== ownershipId ||
      !state ||
      typeof state !== "object" ||
      Reflect.get(state, "Running") !== true
    )
      throw new Error("retained sandbox is unavailable")
  }
}
