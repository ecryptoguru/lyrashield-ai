import type {
  EvidenceChapterId,
  MotionMediaManifest,
  MotionVariant,
} from "../../lib/motion-manifest"

type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (handle: number) => void
  }

class EvidenceWorldElement extends HTMLElement {
  private manifest!: MotionMediaManifest
  private posters: HTMLElement[] = []
  private chapters: HTMLElement[] = []
  private videos: HTMLVideoElement[] = []
  private progressLabel?: HTMLElement
  private progressBar?: HTMLElement
  private activeIndex = 0
  private frontVideo = 0
  private frame = 0
  private seekFrame = 0
  private idleHandle = 0
  private initialized = false
  private motionEnabled = true
  private viewportWidth = 0
  private targetTime = 0
  private targetProgress = 0
  private observer?: IntersectionObserver
  private fetchController?: AbortController
  private objectUrls = new Map<number, string>()
  private videoIndexes = new Map<number, number>()
  private mediaErrors = new Set<string>()
  private viewed = new Set<string>()

  connectedCallback() {
    const raw = this.dataset.manifest
    if (!raw) return
    this.manifest = JSON.parse(raw) as MotionMediaManifest
    this.posters = Array.from(this.querySelectorAll<HTMLElement>("[data-poster-index]"))
    this.chapters = Array.from(this.querySelectorAll<HTMLElement>("[data-chapter-index]"))
    this.videos = Array.from(this.querySelectorAll<HTMLVideoElement>("video"))
    this.progressLabel = this.querySelector<HTMLElement>("[data-progress-label]") ?? undefined
    this.progressBar = this.querySelector<HTMLElement>("[data-progress-bar]") ?? undefined
    this.viewportWidth = innerWidth

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const saveData =
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true
    this.motionEnabled = !reduced && !saveData
    if (!this.motionEnabled) this.captureView(0, "poster")
    this.updatePosters(0)
    this.updateChapters(0)
    this.showPoster()
    this.classList.add("is-enhanced")
    this.videos.forEach((video) => video.addEventListener("seeked", this.queueSeek))
    this.querySelectorAll<HTMLImageElement>("[data-poster-chapter]").forEach((image) =>
      image.addEventListener("error", this.handlePosterError)
    )

    if (this.motionEnabled) {
      this.observer = new IntersectionObserver(this.handleIntent, { rootMargin: "50% 0px" })
      this.observer.observe(this)
    }
  }

  disconnectedCallback() {
    this.observer?.disconnect()
    this.fetchController?.abort()
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.seekFrame)
    const idleWindow = window as IdleWindow
    if (this.idleHandle) idleWindow.cancelIdleCallback?.(this.idleHandle)
    removeEventListener("scroll", this.queueUpdate)
    removeEventListener("resize", this.handleResize)
    removeEventListener("orientationchange", this.handleOrientation)
    removeEventListener("pointerdown", this.primeIos)
    removeEventListener("touchstart", this.primeIos)
    this.videos.forEach((video) => video.removeEventListener("seeked", this.queueSeek))
    this.querySelectorAll<HTMLImageElement>("[data-poster-chapter]").forEach((image) =>
      image.removeEventListener("error", this.handlePosterError)
    )
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url))
    this.objectUrls.clear()
    this.videos.forEach((video) => {
      video.removeAttribute("src")
      video.load()
    })
  }

  private handleIntent = (entries: IntersectionObserverEntry[]) => {
    if (!entries.some((entry) => entry.isIntersecting) || this.initialized) return
    this.observer?.disconnect()
    const idleWindow = window as IdleWindow
    const begin = () => this.initializeMotion()
    if (document.readyState === "complete") {
      this.idleHandle =
        idleWindow.requestIdleCallback?.(begin, { timeout: 1200 }) ?? window.setTimeout(begin, 250)
    } else {
      addEventListener(
        "load",
        () => {
          this.idleHandle =
            idleWindow.requestIdleCallback?.(begin, { timeout: 1200 }) ??
            window.setTimeout(begin, 250)
        },
        { once: true }
      )
    }
  }

  private initializeMotion() {
    if (this.initialized || !this.isConnected) return
    this.initialized = true
    addEventListener("scroll", this.queueUpdate, { passive: true })
    addEventListener("resize", this.handleResize, { passive: true })
    addEventListener("orientationchange", this.handleOrientation, { passive: true })
    addEventListener("pointerdown", this.primeIos, { once: true, passive: true })
    addEventListener("touchstart", this.primeIos, { once: true, passive: true })
    void this.loadPair(this.activeIndex)
    this.queueUpdate()
  }

  private primeIos = () => {
    this.videos.forEach((video) => {
      const attempt = video.play()
      if (attempt) attempt.then(() => video.pause()).catch(() => undefined)
    })
  }

  private handleResize = () => {
    if (innerWidth === this.viewportWidth) {
      this.queueUpdate()
      return
    }
    this.viewportWidth = innerWidth
    this.resetMedia()
    void this.loadPair(this.activeIndex)
    this.queueUpdate()
  }

  private handleOrientation = () => {
    this.viewportWidth = -1
    requestAnimationFrame(this.handleResize)
  }

  private queueUpdate = () => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.updateFromScroll()
    })
  }

  private updateFromScroll() {
    const rect = this.getBoundingClientRect()
    const scrollable = Math.max(this.offsetHeight - innerHeight, 1)
    const progress = Math.min(1, Math.max(0, -rect.top / scrollable))
    this.classList.toggle("is-pinned", rect.top <= 0 && rect.bottom >= innerHeight)
    const chapterCount = this.manifest.chapters.length
    const scaled = Math.min(chapterCount - 0.000001, progress * chapterCount)
    const nextIndex = progress === 1 ? chapterCount - 1 : Math.floor(scaled)
    const chapterProgress = progress === 1 ? 1 : Math.min(1, Math.max(0, scaled - nextIndex))
    this.targetProgress = chapterProgress

    if (nextIndex !== this.activeIndex) {
      const previousFront = this.frontVideo
      this.activeIndex = nextIndex
      this.updatePosters(nextIndex)
      this.updateChapters(nextIndex)
      const readySlot = this.findReadySlot(nextIndex)
      if (!this.motionEnabled || readySlot === undefined) {
        this.showPoster()
      } else {
        const video = this.videos[readySlot]
        this.targetTime = chapterProgress * Math.max(video.duration - 1 / 30, 0)
        if (Math.abs(this.targetTime - video.currentTime) <= this.seekEpsilon())
          this.showVideo(readySlot)
        else this.showPoster()
      }
      if (this.motionEnabled) void this.loadPair(nextIndex, previousFront)
      if (!this.motionEnabled) this.captureView(nextIndex, "poster")
    }

    const currentSlot = this.findReadySlot(nextIndex)
    if (currentSlot !== undefined) {
      const video = this.videos[currentSlot]
      const duration = Math.max(video.duration - 1 / 30, 0)
      this.targetTime = chapterProgress * duration
      this.queueSeek()
    }

    if (this.progressLabel)
      this.progressLabel.textContent = `${String(nextIndex + 1).padStart(2, "0")} / ${String(chapterCount).padStart(2, "0")}`
    if (this.progressBar) this.progressBar.style.transform = `scaleX(${Math.max(0.02, progress)})`
  }

  private queueSeek = () => {
    if (this.seekFrame) return
    this.seekFrame = requestAnimationFrame(this.performSeek)
  }

  private performSeek = () => {
    this.seekFrame = 0
    if (!this.motionEnabled) return
    const slot = this.findReadySlot(this.activeIndex)
    if (slot === undefined) return
    const video = this.videos[slot]
    if (video.seeking) return
    const delta = this.targetTime - video.currentTime
    if (!Number.isFinite(delta)) return
    if (Math.abs(delta) <= this.seekEpsilon()) {
      this.showVideo(slot)
      return
    }
    video.currentTime = Math.min(Math.max(this.targetTime, 0), Math.max(video.duration - 1 / 30, 0))
  }

  private updatePosters(index: number) {
    this.posters.forEach((poster, posterIndex) =>
      poster.classList.toggle("is-active", posterIndex === index)
    )
  }

  private updateChapters(index: number) {
    this.chapters.forEach((chapter, chapterIndex) =>
      chapter.classList.toggle("is-active", chapterIndex === index)
    )
  }

  private showPoster() {
    this.videos.forEach((video) => video.classList.remove("is-front"))
  }

  private showVideo(slot: number) {
    this.frontVideo = slot
    this.videos.forEach((video, videoIndex) =>
      video.classList.toggle("is-front", videoIndex === slot)
    )
  }

  private findReadySlot(index: number) {
    for (const [slot, loadedIndex] of this.videoIndexes) {
      if (
        loadedIndex === index &&
        this.videos[slot].readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      )
        return slot
    }
    return undefined
  }

  private isMobile() {
    return matchMedia("(max-width: 767px)").matches
  }

  private seekEpsilon() {
    return this.isMobile() ? 2 / 30 : 1 / 30
  }

  private getVariant(index: number): MotionVariant {
    const chapter = this.manifest.chapters[index]
    return this.isMobile() ? chapter.portrait : chapter.desktop
  }

  private async loadPair(index: number, previousFront?: number) {
    this.fetchController?.abort()
    const controller = new AbortController()
    this.fetchController = controller
    const currentSlot = this.findReadySlot(index) ?? this.frontVideo
    const nextSlot = 1 - currentSlot
    const nextIndex = Math.min(index + 1, this.manifest.chapters.length - 1)

    try {
      await this.loadVideo(index, currentSlot, controller.signal)
      if (controller.signal.aborted) return
      if (index === this.activeIndex) {
        this.updateFromScroll()
      }

      if (nextIndex !== index) {
        if (previousFront === nextSlot && previousFront !== currentSlot) {
          await this.waitForCrossfade(controller.signal)
        }
        await this.loadVideo(nextIndex, nextSlot, controller.signal)
      }
      if (controller.signal.aborted) return
      this.releaseUnusedMedia(new Set([index, nextIndex]))
    } catch (error) {
      if ((error as DOMException).name === "AbortError") return
      this.motionEnabled = false
      this.showPoster()
      this.captureError(this.manifest.chapters[index].id, "video")
      this.captureView(this.activeIndex, "poster")
    }
  }

  private async waitForCrossfade(signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(finish, 240)
      const abort = () => finish(new DOMException("Aborted", "AbortError"))
      function finish(error?: DOMException) {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        if (error) reject(error)
        else resolve()
      }
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  private async loadVideo(index: number, slot: number, signal: AbortSignal) {
    const video = this.videos[slot]
    if (
      this.videoIndexes.get(slot) === index &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    )
      return

    let objectUrl = this.objectUrls.get(index)
    if (!objectUrl) {
      const variant = this.getVariant(index)
      const blob = await this.fetchVideo(variant, signal)
      objectUrl = URL.createObjectURL(blob)
      this.objectUrls.set(index, objectUrl)
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")

    this.videoIndexes.delete(slot)
    video.preload = "auto"
    video.src = objectUrl
    video.load()
    await this.waitForLoadedData(video, signal)
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    this.videoIndexes.set(slot, index)
    if (index === this.activeIndex) {
      const duration = Math.max(video.duration - 1 / 30, 0)
      this.targetTime = this.targetProgress * duration
      this.queueSeek()
      this.captureView(index, "motion")
    }
  }

  private async fetchVideo(variant: MotionVariant, signal: AbortSignal) {
    let lastError: unknown
    for (const asset of [variant.mp4, variant.webm]) {
      try {
        const response = await fetch(asset, { signal })
        if (!response.ok) throw new Error("media response failed")
        return await response.blob()
      } catch (error) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")
        lastError = error
      }
    }
    throw lastError ?? new Error("media response failed")
  }

  private waitForLoadedData(video: HTMLVideoElement, signal: AbortSignal) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const ready = () => finish()
      const failed = () => finish(new Error("decode failed"))
      const aborted = () => finish(new DOMException("Aborted", "AbortError"))
      const finish = (error?: Error) => {
        video.removeEventListener("loadeddata", ready)
        video.removeEventListener("error", failed)
        signal.removeEventListener("abort", aborted)
        if (error) reject(error)
        else resolve()
      }
      video.addEventListener("loadeddata", ready, { once: true })
      video.addEventListener("error", failed, { once: true })
      signal.addEventListener("abort", aborted, { once: true })
    })
  }

  private releaseUnusedMedia(allowed: Set<number>) {
    for (const [slot, index] of this.videoIndexes) {
      if (allowed.has(index)) continue
      const video = this.videos[slot]
      video.removeAttribute("src")
      video.load()
      this.videoIndexes.delete(slot)
    }
    for (const [index, url] of this.objectUrls) {
      if (allowed.has(index)) continue
      URL.revokeObjectURL(url)
      this.objectUrls.delete(index)
    }
  }

  private resetMedia() {
    this.fetchController?.abort()
    this.showPoster()
    this.targetTime = 0
    this.videoIndexes.clear()
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url))
    this.objectUrls.clear()
    this.videos.forEach((video) => {
      video.removeAttribute("src")
      video.load()
    })
  }

  private handlePosterError = (event: Event) => {
    const chapterId = (event.currentTarget as HTMLImageElement).dataset.posterChapter as
      EvidenceChapterId | undefined
    if (chapterId) this.captureError(chapterId, "poster")
  }

  private captureView(index: number, mode: "poster" | "motion") {
    const chapterId = this.manifest.chapters[index]?.id
    const key = `${chapterId}:${mode}`
    if (!chapterId || this.viewed.has(key)) return
    this.viewed.add(key)
    window.posthog?.capture("cinematic_chapter_view", { chapter_id: chapterId, mode })
  }

  private captureError(chapterId: EvidenceChapterId, assetType: "video" | "poster") {
    const key = `${chapterId}:${assetType}`
    if (this.mediaErrors.has(key)) return
    this.mediaErrors.add(key)
    window.posthog?.capture("cinematic_media_error", {
      chapter_id: chapterId,
      asset_type: assetType,
    })
  }
}

if (!customElements.get("evidence-world"))
  customElements.define("evidence-world", EvidenceWorldElement)
