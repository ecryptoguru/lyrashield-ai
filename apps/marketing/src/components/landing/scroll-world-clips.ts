const CODEC = 'video/mp4; codecs="avc1.640028"'
const MAX_DOWNLOADS = 3

/** One persistent decoder; nearby frames take priority over bounded background transfer. */
export class ScrollClipStream {
  private media: MediaSource
  private buffer?: SourceBuffer
  private lifetime = new AbortController()
  private downloads = new Map<number, AbortController>()
  private ready = new Map<number, Uint8Array<ArrayBuffer>>()
  private unavailable = new Set<number>()
  private sizes = new Map<number, number>()
  private bytes = 0
  private wanted = 0
  private appending = false
  private suspended = false
  private prefetchHealthy = true
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
          this.schedule()
        } catch {
          this.failed()
        }
      },
      { signal: this.lifetime.signal }
    )
    video.src = this.url
    video.preload = "auto"
    video.load()
    // Opening bytes transfer concurrently with media-pipeline initialization.
    this.schedule()
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
    this.schedule()
  }

  suspend() {
    this.suspended = true
    for (const controller of this.downloads.values()) controller.abort("suspended")
  }

  dispose() {
    this.suspend()
    this.lifetime.abort()
    this.ready.clear()
    URL.revokeObjectURL(this.url)
  }

  private order() {
    const nearby = [
      this.wanted,
      this.wanted + 1,
      this.wanted - 1,
      this.wanted + 2,
      this.wanted - 2,
      this.wanted + 3,
      this.wanted + 4,
    ]
    // Once the current frame is available, use spare capacity to warm the film
    // while the visitor reads. Startup never waits for these background bytes.
    const remainder = this.prefetchHealthy ? this.sources.map((_, i) => i) : []
    return [...new Set([...nearby, ...remainder])].filter((i) => i >= 0 && i < this.sources.length)
  }

  private schedule() {
    if (this.suspended || this.lifetime.signal.aborted) return
    if (this.ready.size) void this.appendReady()
    const missing = (i: number) =>
      !this.has(i * this.clipDuration + 0.01) &&
      !this.ready.has(i) &&
      (i === this.wanted || !this.unavailable.has(i))
    const urgent = missing(this.wanted) && !this.downloads.has(this.wanted)
    // Leave only one initial download competing with the hero's critical assets.
    const limit = this.sizes.size ? MAX_DOWNLOADS : 1
    if (urgent && this.downloads.size >= limit) {
      const furthest = [...this.downloads.keys()].sort(
        (a, b) => Math.abs(b - this.wanted) - Math.abs(a - this.wanted)
      )[0]!
      this.downloads.get(furthest)!.abort("superseded")
    }
    for (const index of this.order()) {
      if (this.downloads.size + this.ready.size >= limit) break
      if (!missing(index) || this.downloads.has(index)) continue
      const controller = new AbortController()
      this.downloads.set(index, controller)
      void this.fetchClip(this.sources[index]!, controller, index === this.wanted)
        .then((data) => {
          if (this.lifetime.signal.aborted || controller.signal.aborted) return
          if (!this.sizes.has(index)) {
            this.bytes += data.byteLength
            if (this.bytes > this.byteBudget) {
              this.failed()
              return
            }
            this.sizes.set(index, data.byteLength)
          }
          this.ready.set(index, data)
        })
        .catch(() => {
          if (
            this.lifetime.signal.aborted ||
            this.suspended ||
            (controller.signal.aborted && controller.signal.reason !== "timeout")
          )
            return
          if (index === this.wanted) this.failed()
          else {
            this.unavailable.add(index)
            this.prefetchHealthy = false
          }
        })
        .finally(() => {
          this.downloads.delete(index)
          this.schedule()
        })
    }
  }

  private async appendReady() {
    if (this.appending || !this.buffer || this.suspended || this.lifetime.signal.aborted) return
    this.appending = true
    try {
      while (!this.suspended && !this.lifetime.signal.aborted) {
        const index = this.order().find((i) => this.ready.has(i)) ?? this.ready.keys().next().value
        if (index === undefined) break
        const data = this.ready.get(index)!
        // Retain visited ranges. Deleting a pending frame can strand a decoder.
        await this.mutate(() => {
          this.buffer!.timestampOffset = index * this.clipDuration
          this.buffer!.appendBuffer(data)
        })
        this.ready.delete(index)
        this.changed()
      }
    } catch {
      if (!this.lifetime.signal.aborted) this.failed()
    } finally {
      this.appending = false
      this.scheduleDownloadsAfterAppend()
    }
  }

  private scheduleDownloadsAfterAppend() {
    // Avoid recursive append attempts when there is nothing ready to consume.
    if (
      this.ready.size ||
      this.downloads.size >= MAX_DOWNLOADS ||
      this.suspended ||
      this.lifetime.signal.aborted
    )
      return
    queueMicrotask(() => this.schedule())
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
    const timeout = setTimeout(() => controller.abort("timeout"), 15000)
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
