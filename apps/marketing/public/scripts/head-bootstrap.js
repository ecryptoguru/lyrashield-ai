;(() => {
  try {
    const cookiePreference = document.cookie.match(
      /(?:^|; )lyrashield-theme=(system|light|dark)(?:;|$)/
    )?.[1]
    const storedPreference = localStorage.getItem("lyrashield-theme")
    const preference = cookiePreference || storedPreference || "system"
    if (
      !cookiePreference &&
      (storedPreference === "system" || storedPreference === "light" || storedPreference === "dark")
    ) {
      const domain =
        location.hostname === "lyrashieldai.com" || location.hostname.endsWith(".lyrashieldai.com")
          ? "; Domain=.lyrashieldai.com"
          : ""
      document.cookie = `lyrashield-theme=${storedPreference}; Max-Age=31536000; Path=/${domain}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`
    }
    const dark =
      preference === "dark" ||
      (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.dataset.theme = dark ? "dark" : "light"
    document.documentElement.dataset.themePreference = preference
    document
      .querySelector("meta[data-theme-color]")
      ?.setAttribute("content", dark ? "#08111c" : "#f5f9fc")
  } catch {}
})()

/* Opt into the scroll-reveal pre-state before first paint to avoid a
         flash-of-visible-then-hidden. Gated on motion + data preferences and
         IntersectionObserver support, so no-JS / reduced-motion / data-saver
         users always render fully visible. Observation wiring loads after. */
;(() => {
  try {
    const connection = navigator.connection
    if (
      "IntersectionObserver" in window &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches &&
      !(connection && connection.saveData === true)
    ) {
      document.documentElement.classList.add("reveal-ready")
    }
  } catch {}
})()
