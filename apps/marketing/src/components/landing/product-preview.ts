const preview = document.querySelector<HTMLDialogElement>(".product-preview")
const image = preview?.querySelector<HTMLImageElement>("[data-product-image]")
let trigger: HTMLButtonElement | undefined
let scrollLock: string | undefined

const views = document.querySelector<HTMLElement>(".hero-frame__views")
const panels = document.querySelectorAll<HTMLElement>("[data-product-panel]")
const selectors = document.querySelectorAll<HTMLButtonElement>("[data-product-select]")

function selectView(id: string) {
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.productPanel !== id
  })
  selectors.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.productSelect === id))
  })
}

if (views && panels.length && selectors.length) {
  selectors.forEach((button) => {
    button.addEventListener("click", () => selectView(button.dataset.productSelect!))
  })
  selectView("overview")
  views.hidden = false
}

function restorePreview() {
  if (scrollLock !== undefined) document.documentElement.style.overflow = scrollLock
  scrollLock = undefined
  trigger?.focus({ preventScroll: true })
}

function closePreview() {
  preview?.close()
  // Native close events are queued. Restore before a visitor can reopen a
  // different preview and accidentally retain the previous modal's scroll lock.
  restorePreview()
}

function setPreviewImage() {
  if (!image || !trigger) return
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark"
  const source = trigger.parentElement?.querySelector<HTMLImageElement>(
    ".hero-frame__img--" + theme
  )
  if (!source) return
  const title = preview?.querySelector("#product-preview-title")
  if (title) title.textContent = `${trigger.dataset.productTitle ?? "Current dashboard"} preview`
  image.src = source.currentSrc || source.src
  image.alt = source.alt
  image.width = source.width
  image.height = source.height
}

if (preview && image && typeof preview.showModal === "function") {
  document.querySelectorAll<HTMLButtonElement>("[data-product-expand]").forEach((button) => {
    button.hidden = false
    button.addEventListener("click", () => {
      trigger = button
      setPreviewImage()
      scrollLock = document.documentElement.style.overflow
      document.documentElement.style.overflow = "hidden"
      preview.showModal()
      preview.querySelector(".product-preview__scroll")?.scrollTo(0, 0)
      preview.querySelector<HTMLButtonElement>("[data-product-close]")?.focus()
    })
  })
  preview.querySelector("[data-product-close]")?.addEventListener("click", closePreview)
  preview.addEventListener("click", (event) => {
    if (event.target === preview) closePreview()
  })
  preview.addEventListener("cancel", (event) => {
    event.preventDefault()
    closePreview()
  })
  preview.addEventListener("close", () => {
    if (!preview.open) restorePreview()
  })
  new MutationObserver(() => {
    if (preview.open) setPreviewImage()
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
}
