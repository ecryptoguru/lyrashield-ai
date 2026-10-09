/** Only an explicit object-not-found response authorizes creating a new key. */
export function assertObjectAbsent(result, key) {
  if (result.status === 0) throw new Error(`Refusing to overwrite immutable media ${key}`)
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (result.error || result.signal || !/\b404\b/.test(output))
    throw new Error(`Cannot establish that ${key} is absent; publication stopped. ${output}`)
}
