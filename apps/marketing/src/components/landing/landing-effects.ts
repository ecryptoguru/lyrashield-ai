/** One-shot evidence arrivals; critical copy and controls stay visible. */
const arrivals = document.querySelectorAll<HTMLElement>("[data-evidence-arrival]")
const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
if ("IntersectionObserver" in window && !connection?.saveData) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add("is-arrived")
        observer.unobserve(entry.target)
      }
    },
    { threshold: 0.15 }
  )
  arrivals.forEach((element) => observer.observe(element))
}
