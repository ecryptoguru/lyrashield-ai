/* First-touch acquisition handoff: append the current page's utm_* and a
         bounded route-name token to app sign-up links. Runs regardless of
         analytics consent — it only rewrites hrefs, never sends data. The app
         revalidates every value against an allowlist. */
;(() => {
  try {
    const params = new URLSearchParams(location.search)
    const route = location.pathname === "/" ? "home" : location.pathname.split("/")[1] || "home"
    document.querySelectorAll('a[href^="https://app.lyrashieldai.com/sign-up"]').forEach((a) => {
      try {
        const href = new URL(a.getAttribute("href"))
        for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
          const value = params.get(key)
          if (value && !href.searchParams.get(key)) href.searchParams.set(key, value)
        }
        if (!href.searchParams.get("from")) href.searchParams.set("from", route)
        a.setAttribute("href", href.toString())
      } catch {}
    })
  } catch {}
})()
