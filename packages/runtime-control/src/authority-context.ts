import { AsyncLocalStorage } from "node:async_hooks"
import { AuthorityFenceError, type AuthorityAction } from "./authority-fence"
import type { AuthoritySqlConnection } from "./postgres-mirror"

/** Per-installed-fence capability; never shares a connection across requests. */
export class ScanAuthorityContext {
  private readonly storage = new AsyncLocalStorage<{
    connection: AuthoritySqlConnection
    binding: AuthorityAction
    guardId: string
    assertActive: () => void
  }>()

  run<T>(
    value: {
      connection: AuthoritySqlConnection
      binding: AuthorityAction
      guardId: string
      assertActive: () => void
    },
    effect: () => T
  ): T {
    value.assertActive()
    return this.storage.run(Object.freeze(value), effect)
  }

  current() {
    const value = this.storage.getStore()
    if (!value) return undefined
    value.assertActive()
    return value
  }

  forOperation(operationId: string) {
    const value = this.current()
    if (value && value.binding.operationId !== operationId) throw new AuthorityFenceError()
    return value
  }
}
