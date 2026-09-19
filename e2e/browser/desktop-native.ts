// Stub only the native transport; production typed wrappers and screens run unchanged.
declare global {
  interface Window {
    desktopNative: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
    }
  }
}
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return window.desktopNative.invoke(command, args) as Promise<T>
}
export async function listen<T>(event: string, handler: (event: { payload: T }) => void) {
  return window.desktopNative.listen(event, handler as (event: { payload: unknown }) => void)
}
// Shell imports this native primitive; shell operations are outside this harness.
export class Channel<T> {
  onmessage?: (message: T) => void
}
