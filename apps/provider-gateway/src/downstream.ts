import type { ServerResponse } from "node:http"
import { MAX_DELIVERY_CHUNK_BYTES } from "./proxy-utils"

export interface ProviderStreamSink {
  signal: AbortSignal
  // Submit effects synchronously; promises acknowledge drain/finish only.
  // The service invokes each effect under its grant/revocation fence.
  start(statusCode: number, headers: Record<string, string>): void
  write(chunk: Uint8Array): Promise<void>
  complete(): Promise<void>
}

export async function deliverReplay(
  response: { statusCode: number; headers: Record<string, string>; body: Buffer },
  sink: ProviderStreamSink,
  deliver: (effect: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  await deliver(() => sink.start(response.statusCode, response.headers))
  for (let offset = 0; offset < response.body.byteLength; offset += MAX_DELIVERY_CHUNK_BYTES)
    await deliver(() =>
      sink.write(response.body.subarray(offset, offset + MAX_DELIVERY_CHUNK_BYTES))
    )
  await deliver(() => sink.complete())
}

export function httpStreamSink(response: ServerResponse, signal: AbortSignal): ProviderStreamSink {
  return {
    signal,
    start(statusCode, headers) {
      response.writeHead(statusCode, {
        ...headers,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      })
      response.flushHeaders()
    },
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        let accepted: boolean | undefined
        let flushed = false
        let drained = false
        const cleanup = () => {
          response.off("error", failed)
          response.off("close", closed)
          response.off("drain", drain)
        }
        const failed = (error: Error) => {
          cleanup()
          reject(error)
        }
        const closed = () => failed(new Error("downstream disconnected"))
        const done = () => {
          if (accepted !== undefined && flushed && (accepted || drained)) {
            cleanup()
            resolve()
          }
        }
        const drain = () => {
          drained = true
          done()
        }
        response.once("error", failed)
        response.once("close", closed)
        response.once("drain", drain)
        try {
          accepted = response.write(chunk, (error) => {
            if (error) return failed(error)
            flushed = true
            done()
          })
          done()
        } catch (error) {
          failed(error instanceof Error ? error : new Error("downstream write failed"))
        }
      })
    },
    complete() {
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          response.off("error", failed)
          response.off("close", closed)
        }
        const failed = (error: Error) => {
          cleanup()
          reject(error)
        }
        const closed = () => failed(new Error("downstream disconnected"))
        response.once("error", failed)
        response.once("close", closed)
        try {
          response.end(() => {
            cleanup()
            resolve()
          })
        } catch (error) {
          failed(error instanceof Error ? error : new Error("downstream completion failed"))
        }
      })
    },
  }
}
