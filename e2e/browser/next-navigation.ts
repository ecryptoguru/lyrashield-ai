const navigate = (url: string) =>
  window.dispatchEvent(new CustomEvent("test:navigate", { detail: url }))
const router = { refresh() {}, push: navigate, replace: navigate }

export function useRouter() {
  return router
}

export function usePathname() {
  return "/dashboard"
}

export function useSearchParams() {
  return new URLSearchParams(window.location.search)
}
