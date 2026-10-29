const CODEC = 'video/mp4; codecs="avc1.640028"'

/** One persistent decoder, with a byte-bounded cache of visited encoded clips. */
export class ScrollClipStream {
  private media: MediaSource
  private buffer?: SourceBuffer
  private lifetime = new AbortController()
  private pending?: {
    index: number
    controller: AbortController
    promise: Promise<Uint8Array<ArrayBuffer>>
  }
  private download?: AbortController
  private downloading = -1
  private wanted = 0
  private unavailable = new Set<number>()
  private sizes = new Map<number, number>()
  private bytes = 0
  private running = false
  private suspended = false
  private url: string

  static supported() {
    const Media =
      globalThis.MediaSource ??
      (
        globalThis as typeof globalThis & {
          ManagedMediaSource?: typeof MediaSource
        }
      ).ManagedMediaSource
    return Media?.isTypeSupported(CODEC) ? Media : undefined
  }

  constructor(
    video: HTMLVideoElement,
    private sources: readonly string[],
    private clipDuration: number,
    duration: number,
    private byteBudget: number,
    private changed: () => void,
    private failed: () => void
  ) {
    const Media = ScrollClipStream.supported()!
    this.media = new Media()
    video.disableRemotePlayback = true
    this.url = URL.createObjectURL(this.media)
    this.media.addEventListener(
      "sourceopen",
      () => {
        if (this.buffer || this.lifetime.signal.aborted) return
        try {
          this.buffer = this.media.addSourceBuffer(CODEC)
          this.media.duration = duration
          void this.pump()
        } catch {
          this.failed()
        }
      },
      { signal: this.lifetime.signal }
    )
    video.src = this.url
    video.preload = "auto"
    video.load()
    // Transfer the opening clip while the browser opens its media pipeline.
    void this.load(0).promise.catch(() => {
      /* pump handles download failure */
    })
  }

  get busy() {
    return this.buffer?.updating ?? true
  }

  has(time: number) {
    const ranges = this.buffer?.buffered
    if (!ranges) return false
    for (let i = 0; i < ranges.length; i++) {
      if (time >= ranges.start(i) - 0.001 && time < ranges.end(i) - 0.001) return true
    }
    return false
  }

  request(time: number) {
    this.wanted = Math.min(this.sources.length - 1, Math.floor(time / this.clipDuration))
    this.suspended = false
    if (this.downloading >= 0 && this.downloading !== this.wanted && !this.has(time))
      this.download?.abort("superseded")
    void this.pump()
  }

  suspend() {
    this.suspended = true
    this.download?.abort()
  }

  dispose() {
    this.suspend()
    this.lifetime.abort()
    URL.revokeObjectURL(this.url)
  }

  private nearby() {
    return [
      this.wanted,
      this.wanted + 1,
      this.wanted - 1,
      this.wanted + 2,
      this.wanted - 2,
      this.wanted + 3,
      this.wanted + 4,
    ].filter((i) => i >= 0 && i < this.sources.length)
  }

  private load(index: number) {
    if (this.pending?.index === index && !this.pending.controller.signal.aborted)
      return this.pending
    this.download?.abort("superseded")
    const controller = new AbortController()
    this.download = controller
    this.downloading = index
    this.pending = {
      index,
      controller,
      promise: this.fetchClip(this.sources[index]!, controller, index === this.wanted),
    }
    return this.pending
  }

  private async pump() {
    if (this.running || !this.buffer || this.suspended || this.lifetime.signal.aborted) return
    this.running = true
    try {
      while (!this.suspended && !this.lifetime.signal.aborted) {
        const index = this.nearby().find(
          (i) =>
            !this.has(i * this.clipDuration + 0.01) &&
            (!this.unavailable.has(i) || i === this.wanted)
        )
        if (index === undefined) break
        const pending = this.load(index)
        const download = pending.controller
        let data: Uint8Array<ArrayBuffer>
        try {
          data = await pending.promise
        } catch (error) {
          if (
            download.signal.aborted &&
            (this.suspended ||
              this.lifetime.signal.aborted ||
              download.signal.reason === "superseded")
          )
            continue
          if (index !== this.wanted) {
            this.unavailable.add(index)
            continue
          }
          throw error
        } finally {
          if (this.pending === pending) this.pending = undefined
          this.downloading = -1
        }
        if (this.suspended || this.lifetime.signal.aborted) break
        if (!this.nearby().includes(index)) continue
        if (!this.sizes.has(index)) {
          this.bytes += data.byteLength
          if (this.bytes > this.byteBudget) throw new Error("Motion stream exceeds budget")
          this.sizes.set(index, data.byteLength)
        }
        // Retain visited ranges: deleting frames during a seek can strand a decoder.
        // The immutable film and per-clip limits bound memory; the browser can evict.
        await this.mutate(() => {
          this.buffer!.timestampOffset = index * this.clipDuration
          this.buffer!.appendBuffer(data)
        })
        this.changed()
      }
    } catch {
      if (!this.lifetime.signal.aborted) this.failed()
    } finally {
      this.running = false
      this.download = undefined
    }
  }

  private mutate(operation: () => void) {
    return new Promise<void>((resolve, reject) => {
      if (this.lifetime.signal.aborted) {
        reject(new Error("Released stream"))
        return
      }
      const buffer = this.buffer!
      const finish = (event: Event) => {
        buffer.removeEventListener("updateend", finish)
        buffer.removeEventListener("error", finish)
        this.lifetime.signal.removeEventListener("abort", finish)
        if (event.type === "updateend") resolve()
        else reject(new Error("Motion buffer unavailable"))
      }
      buffer.addEventListener("updateend", finish, { once: true })
      buffer.addEventListener("error", finish, { once: true })
      this.lifetime.signal.addEventListener("abort", finish, { once: true })
      try {
        operation()
      } catch {
        finish(new Event("error"))
      }
    })
  }

  private async fetchClip(source: string, controller: AbortController, urgent: boolean) {
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(source, {
        signal: controller.signal,
        priority: urgent ? "high" : "low",
      })
      if (!response.ok || !response.body) throw new Error("Motion download unavailable")
      const reader = response.body.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let bytes = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        // Per-request bound; the complete film also has a verified byte budget.
        if (bytes > 2 * 1024 * 1024) {
          await reader.cancel()
          throw new Error("Motion clip exceeds budget")
        }
        chunks.push(value)
      }
      return new Uint8Array(await new Blob(chunks).arrayBuffer())
    } finally {
      clearTimeout(timeout)
    }
  }
}
