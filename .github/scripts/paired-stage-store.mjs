// Persistent authority stays on the configured dedicated worker VM, across jobs.
export function vmStageStore(guest) {
  const call = async (operation, owner, stage, record) => {
    const request = { operation, owner }
    if (record !== undefined) {
      request.stage = stage
      request.body = JSON.stringify(record) + "\n"
    }
    if ((await guest("stage-store", request)) !== true)
      throw new Error("Protected stage storage unconfirmed")
  }
  return Object.freeze({
    directory: (owner) => call("directory", owner),
    createDirectory: (owner) => call("create-directory", owner),
    write: (owner, stage, record) => call("write", owner, stage, record),
    assert: (owner, stage, record) => call("assert", owner, stage, record),
  })
}
