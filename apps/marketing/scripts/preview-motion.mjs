import { createServer } from "node:http"
import { createReadStream, existsSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { createBrotliCompress, createGzip, constants } from "node:zlib"
import { createRequire } from "node:module"

// Development-only proxy: Wrangler's local assets ignore Range. Production
// films are served from the range-capable immutable media origin.
const mediaRoot = resolve("dist/client")
const require = createRequire(import.meta.url)
const cli = resolve(dirname(require.resolve("wrangler/package.json")), "wrangler-dist/cli.js")
const migrations = spawnSync(
  process.execPath,
  [
    cli,
    "d1",
    "migrations",
    "apply",
    "lyrashield-marketing-waitlist",
    "--local",
    "--config",
    "dist/server/wrangler.json",
  ],
  { stdio: "inherit", env: { ...process.env, CI: "1" } }
)
if (migrations.status !== 0) throw new Error("Local preview database preparation failed")
const wrangler = spawn(
  process.execPath,
  [
    cli,
    "dev",
    "--local",
    "--port",
    "8858",
    "--config",
    "dist/server/wrangler.json",
    ...(process.env.PUBLIC_APP_URL
      ? ["--var", `PUBLIC_APP_URL:${process.env.PUBLIC_APP_URL}`]
      : []),
  ],
  { stdio: "inherit" }
)
const mediaPath =
  /^\/media-local\/(?:assurance-world\/v3\/local\/(?:desktop|portrait)\/assurance-world\.mp4|scroll-spike\/desktop-(?:30|60)\.mp4)$/
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:8787")
  if (mediaPath.test(url.pathname) && ["GET", "HEAD"].includes(request.method ?? "")) {
    const file = resolve(mediaRoot, `.${url.pathname}`)
    if (!existsSync(file)) {
      response.writeHead(404)
      response.end()
      return
    }
    const size = statSync(file).size
    const range = request.headers.range
    let start = 0,
      end = size - 1
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (!match || Number(match[1]) >= size || (match[2] && Number(match[2]) < Number(match[1]))) {
        response.writeHead(416, { "Content-Range": `bytes */${size}` })
        response.end()
        return
      }
      start = Number(match[1])
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    }
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    })
    if (request.method === "HEAD") {
      response.end()
      return
    }
    const stream = createReadStream(file, { start, end })
    response.on("close", () => stream.destroy())
    stream.on("error", () => response.destroy())
    stream.pipe(response)
    return
  }
  try {
    const headers = { ...request.headers, host: "127.0.0.1:8858" }
    delete headers.connection
    const upstream = await fetch(`http://127.0.0.1:8858${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(!["GET", "HEAD"].includes(request.method ?? "GET")
        ? { body: request, duplex: "half" }
        : {}),
      redirect: "manual",
    })
    const outgoing = Object.fromEntries(upstream.headers)
    delete outgoing["content-encoding"]
    delete outgoing["content-length"]
    // Static _headers are production-shaped; Safari upgrades loopback asset
    // requests when this directive is present on a plain-HTTP local preview.
    if (outgoing["content-security-policy"])
      outgoing["content-security-policy"] = outgoing["content-security-policy"].replace(
        /;?\s*upgrade-insecure-requests/g,
        ""
      )
    // Match the production edge's text compression. MP4 ranges above stay
    // byte-for-byte, so decoder and transfer measurements remain meaningful.
    const accepted = new Set(
      (request.headers["accept-encoding"] ?? "").split(",").map((value) => value.trim())
    )
    const text = /^(?:text\/|application\/(?:javascript|json|xml))/.test(
      outgoing["content-type"] ?? ""
    )
    const encoding =
      text && upstream.status === 200 && request.method !== "HEAD"
        ? accepted.has("br")
          ? "br"
          : accepted.has("gzip")
            ? "gzip"
            : undefined
        : undefined
    if (encoding) {
      outgoing["content-encoding"] = encoding
      outgoing.vary = outgoing.vary ? `${outgoing.vary}, Accept-Encoding` : "Accept-Encoding"
      if (outgoing.etag && !outgoing.etag.startsWith("W/")) outgoing.etag = `W/${outgoing.etag}`
    }
    response.writeHead(upstream.status, outgoing)
    if (upstream.body && request.method !== "HEAD") {
      const stream = Readable.fromWeb(upstream.body)
      stream.on("error", () => response.destroy())
      if (encoding) {
        const encoder =
          encoding === "br"
            ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
            : createGzip()
        encoder.on("error", () => response.destroy())
        stream.pipe(encoder).pipe(response)
      } else stream.pipe(response)
    } else response.end()
  } catch {
    response.writeHead(503)
    response.end("Preview is starting")
  }
})
server.listen(8787, "127.0.0.1", () => console.log("Motion preview: http://127.0.0.1:8787"))
function stop() {
  server.close()
  wrangler.kill("SIGTERM")
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
wrangler.on("exit", (code) => {
  server.close()
  process.exit(code ?? 1)
})
