import { request } from "node:http"
import { createHash } from "node:crypto"
import { z } from "zod"
import { nativeEngineResultChunkSchema } from "@lyrashield/runtime-control"
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
/** Large bytes use the broker transport; independent root proof authorizes them. */
export function createWorkerNativeResultClient(credential: string) {
  if (
    credential.length < 32 ||
    credential.length > 1024 ||
    credential.trim() !== credential ||
    /[\r\n]/.test(credential)
  )
    throw new Error("Worker result credential unavailable")
  return async (operationId: string, attemptId: string): Promise<Buffer | null> => {
    id.parse(operationId)
    id.parse(attemptId)
    const chunks: Buffer[] = []
    let offset = 0,
      sha256: string | undefined,
      totalBytes: number | undefined
    while (offset < 96 * 1024 * 1024) {
      const response = await new Promise<unknown>((resolve, reject) => {
        let settled = false,
          size = 0
        const parts: Buffer[] = []
        const req = request(
          {
            socketPath: "/run/lyrashield/broker.sock",
            method: "POST",
            path: `/operations/${operationId}/result`,
            headers: {
              authorization: `Bearer ${credential}`,
              "content-type": "application/json",
              accept: "application/json",
            },
          },
          (res) => {
            if (res.statusCode !== 200) return finish(new Error("Worker result unavailable"))
            res.on("data", (part: Buffer) => {
              size += part.length
              if (size > 2 * 1024 * 1024) finish(new Error("Worker result exceeds bound"))
              else parts.push(part)
            })
            res.once("aborted", () => finish(new Error("Worker result interrupted")))
            res.once("error", finish)
            res.once("end", () => {
              try {
                finish(undefined, JSON.parse(Buffer.concat(parts).toString("utf8")))
              } catch {
                finish(new Error("Worker result malformed"))
              }
            })
          }
        )
        const timer = setTimeout(() => finish(new Error("Worker result timed out")), 5000)
        function finish(error?: Error, value?: unknown) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) {
            req.destroy()
            reject(error)
          } else resolve(value)
        }
        req.once("error", finish)
        req.end(JSON.stringify({ attemptId, offset }))
      })
      const part = nativeEngineResultChunkSchema.parse(response)
      if (part.operationId !== operationId || part.attemptId !== attemptId)
        throw new Error("Worker result scope mismatch")
      if (part.kind !== "available") return null
      if (
        part.offset !== offset ||
        (sha256 && sha256 !== part.sha256) ||
        (totalBytes && totalBytes !== part.totalBytes)
      )
        throw new Error("Worker result changed")
      sha256 = part.sha256
      totalBytes = part.totalBytes
      const bytes = Buffer.from(part.base64, "base64")
      if (
        bytes.length === 0 ||
        bytes.length > 1024 * 1024 ||
        bytes.toString("base64") !== part.base64 ||
        offset + bytes.length > totalBytes
      )
        throw new Error("Worker result chunk invalid")
      chunks.push(bytes)
      offset += bytes.length
      if (part.eof !== (offset === totalBytes)) throw new Error("Worker result truncated")
      if (part.eof) {
        const body = Buffer.concat(chunks)
        if (`sha256:${createHash("sha256").update(body).digest("hex")}` !== sha256)
          throw new Error("Worker result checksum mismatch")
        return body
      }
    }
    throw new Error("Worker result exceeds bound")
  }
}
