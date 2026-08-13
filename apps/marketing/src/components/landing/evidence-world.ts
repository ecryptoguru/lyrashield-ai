import type { EvidenceChapterId, MotionMediaManifest } from "../../lib/motion-manifest"

type SourceKind = "desktop" | "portrait"

class EvidenceWorldElement extends HTMLElement {
  private manifest!: MotionMediaManifest
  private posters: HTMLElement[] = []
  private chapters: HTMLElement[] = []
  private video!: HTMLVideoElement
  private progressLabel?: HTMLElement
  private progressBar?: HTMLElement
  private activeIndex = 0
  private activeCardIndex = 0
  private frame = 0
  private seekFrame = 0
  private paintPending = false
  private initialized = false
  private motionEnabled = true
  private viewportWidth = 0
  private targetTime = 0
  private sourceKind?: SourceKind
  private observer?: IntersectionObserver
  private mediaErrors = new Set<string>()
  private viewed = new Set<string>()

  connectedCallback() {
    const raw = this.dataset.manifest
    if (!raw) return

    this.manifest = JSON.parse(raw) as MotionMediaManifest
    this.posters = Array.from(this.querySelectorAll<HTMLElement>("[data-poster-index]"))
    this.chapters = Array.from(this.querySelectorAll<HTMLElement>("[data-chapter-index]"))
    this.video = this.querySelector<HTMLVideoElement>("video")!
    this.progressLabel = this.querySelector<HTMLElement>("[data-progress-label]") ?? undefined
    this.progressBar = this.querySelector<HTMLElement>("[data-progress-bar]") ?? undefined
    this.viewportWidth = innerWidth

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const saveData =
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true
    this.motionEnabled = !reduced && !saveData

    this.updatePosters(0)
    this.updateChapters(0)
    this.updateCards(0, 0)
    this.showPoster()
    this.querySelectorAll<HTMLImageElement>("[data-poster-chapter]").forEach((image) =>
      image.addEventListener("error", this.handlePosterError)
    )

    if (!this.motionEnabled) {
      this.captureView(0, "poster")
      return
    }

    this.classList.add("is-enhanced")
    this.video.addEventListener("loadedmetadata", this.queueUpdate)
    this.video.addEventListener("loadeddata", this.queueUpdate)
    this.video.addEventListener("seeked", this.handleSeeked)
    this.video.addEventListener("error", this.handleVideoError)
    this.observer = new IntersectionObserver(this.handleIntent, { rootMargin: "50% 0px" })
    this.observer.observe(this)
  }

  disconnectedCallback() {
    this.observer?.disconnect()
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.seekFrame)
    removeEventListener("scroll", this.queueUpdate)
    removeEventListener("resize", this.handleResize)
    removeEventListener("orientationchange", this.handleOrientation)
    removeEventListener("pointerdown", this.primeIos)
    this.video?.removeEventListener("loadedmetadata", this.queueUpdate)
    this.video?.removeEventListener("loadeddata", this.queueUpdate)
    this.video?.removeEventListener("seeked", this.handleSeeked)
    this.video?.removeEventListener("error", this.handleVideoError)
    this.querySelectorAll<HTMLImageElement>("[data-poster-chapter]").forEach((image) =>
      image.removeEventListener("error", this.handlePosterError)
    )
    this.video?.removeAttribute("src")
    this.video?.load()
  }

  private handleIntent = (entries: IntersectionObserverEntry[]) => {
    if (this.initialized || !entries.some((entry) => entry.isIntersecting)) return
    this.observer?.disconnect()
    this.initializeMotion()
  }

  private initializeMotion() {
    if (this.initialized || !this.isConnected) return
    this.initialized = true
    addEventListener("scroll", this.queueUpdate, { passive: true })
    addEventListener("resize", this.handleResize, { passive: true })
    addEventListener("orientationchange", this.handleOrientation, { passive: true })
    addEventListener("pointerdown", this.primeIos, { once: true, passive: true })
    this.assignSource()
    this.queueUpdate()
  }

  private selectedSourceKind(): SourceKind {
    return matchMedia("(max-width: 767px)").matches ? "portrait" : "desktop"
  }

  private assignSource() {
    if (!this.motionEnabled) return
    const nextKind = this.selectedSourceKind()
    const nextTrack = this.manifest[nextKind]
    if (this.sourceKind === nextKind && this.video.src) return

    this.sourceKind = nextKind
    this.showPoster()
    this.paintPending = false
    this.video.preload = "metadata"
    this.video.src = nextTrack.src
    this.video.load()
  }

  private primeIos = () => {
    const attempt = this.video.play()
    if (attempt) attempt.then(() => this.video.pause()).catch(() => undefined)
  }

  private handleResize = () => {
    if (innerWidth === this.viewportWidth) {
      this.queueUpdate()
      return
    }

    this.viewportWidth = innerWidth
    this.assignSource()
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
    const worldRect = this.getBoundingClientRect()
    this.classList.toggle("is-pinned", worldRect.top <= 0 && worldRect.bottom >= innerHeight)

    const anchor = innerHeight * (this.selectedSourceKind() === "portrait" ? 0.68 : 0.5)
    let nextIndex = this.activeIndex
    let chapterProgress = 0

    for (let index = 0; index < this.chapters.length; index += 1) {
      const rect = this.chapters[index].getBoundingClientRect()
      if (anchor >= rect.top && anchor <= rect.bottom) {
        nextIndex = index
        chapterProgress = this.clamp((anchor - rect.top) / Math.max(rect.height, 1))
        break
      }
      if (rect.bottom < anchor) {
        nextIndex = index
        chapterProgress = 1
      }
    }

    if (nextIndex !== this.activeIndex) {
      this.activeIndex = nextIndex
      this.activeCardIndex = 0
      this.updatePosters(nextIndex)
      this.updateChapters(nextIndex)
      this.updateCards(nextIndex, 0)
      this.showPoster()
    }

    const cards = this.chapters[nextIndex].querySelectorAll<HTMLElement>("[data-story-card-index]")
    const nextCardIndex = cards.length > 1 && chapterProgress >= 0.55 ? 1 : 0
    if (nextCardIndex !== this.activeCardIndex) {
      this.activeCardIndex = nextCardIndex
      this.updateCards(nextIndex, nextCardIndex)
    }

    const chapter = this.manifest.chapters[nextIndex]
    const frame = 1 / 30
    this.targetTime =
      chapter.start + chapterProgress * Math.max(chapter.end - chapter.start - frame, 0)
    this.queueSeek()

    const totalProgress = this.clamp(this.targetTime / this.manifest.desktop.duration)
    if (this.progressLabel)
      this.progressLabel.textContent = `${String(nextIndex + 1).padStart(2, "0")} / ${String(this.chapters.length).padStart(2, "0")}`
    if (this.progressBar)
      this.progressBar.style.transform = `scaleX(${Math.max(0.02, totalProgress)})`
  }

  private queueSeek = () => {
    if (this.seekFrame) return
    this.seekFrame = requestAnimationFrame(this.performSeek)
  }

  private performSeek = () => {
    this.seekFrame = 0
    if (!this.motionEnabled || this.video.readyState < HTMLMediaElement.HAVE_METADATA) return

    const video = this.video
    if (video.seeking) return

    const duration = Math.max(video.duration - 1 / 30, 0)
    const target = Math.min(Math.max(this.targetTime, 0), duration)
    if (Math.abs(target - video.currentTime) <= this.seekEpsilon()) {
      this.showVideo()
      return
    }

    try {
      video.currentTime = target
    } catch {
      this.showPoster()
    }
  }

  private handleSeeked = () => {
    if (Math.abs(this.targetTime - this.video.currentTime) > this.seekEpsilon()) {
      this.queueSeek()
      return
    }
    this.showVideo()
  }

  private showVideo() {
    if (
      this.paintPending ||
      this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      this.video.seeking
    )
      return

    this.paintPending = true
    const painted = () => {
      if (!this.paintPending) return
      this.paintPending = false
      if (this.video.seeking || !this.isConnected) return
      this.video.classList.add("is-front")
      this.captureView(this.activeIndex, "motion-v2")
    }
    if ("requestVideoFrameCallback" in this.video) {
      this.video.requestVideoFrameCallback(painted)
      // A paused seek can present a frame without dispatching rVFC on some browsers.
      setTimeout(painted, 120)
    } else requestAnimationFrame(painted)
  }

  private showPoster() {
    this.video.classList.remove("is-front")
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

  private updateCards(chapterIndex: number, cardIndex: number) {
    this.chapters.forEach((chapter, index) => {
      chapter
        .querySelectorAll<HTMLElement>("[data-story-card-index]")
        .forEach((card) =>
          card.classList.toggle(
            "is-card-active",
            index === chapterIndex && Number(card.dataset.storyCardIndex) === cardIndex
          )
        )
    })
  }

  private seekEpsilon() {
    return this.selectedSourceKind() === "portrait" ? 2 / 30 : 1 / 30
  }

  private clamp(value: number) {
    return Math.min(1, Math.max(0, value))
  }

  private handleVideoError = () => {
    this.motionEnabled = false
    this.showPoster()
    this.captureError(this.manifest.chapters[this.activeIndex].id, "video")
    this.captureView(this.activeIndex, "poster")
  }

  private handlePosterError = (event: Event) => {
    const chapterId = (event.currentTarget as HTMLImageElement).dataset.posterChapter as
      EvidenceChapterId | undefined
    if (chapterId) this.captureError(chapterId, "poster")
  }

  private captureView(index: number, mode: "poster" | "motion-v2") {
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
      source_kind: this.sourceKind,
    })
  }
}

if (!customElements.get("evidence-world"))
  customElements.define("evidence-world", EvidenceWorldElement)
