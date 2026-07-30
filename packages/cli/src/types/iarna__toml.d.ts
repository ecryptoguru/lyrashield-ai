declare module "@iarna/toml" {
  export function parse(input: string): unknown
  export function stringify(value: unknown): string
  export function parseAsync(input: string): Promise<unknown>
}
