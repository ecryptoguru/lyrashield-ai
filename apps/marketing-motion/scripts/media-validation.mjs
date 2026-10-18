/** Validate top-level ISO BMFF boxes, including extended and end-of-file sizes. */
export function assertFaststartBytes(bytes) {
  const boxes = []
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 8) throw new Error("Malformed MP4 box header")
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    let size = bytes.readUInt32BE(offset)
    let header = 8
    if (size === 1) {
      if (bytes.length - offset < 16) throw new Error("Malformed extended MP4 box")
      size = Number(bytes.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) size = bytes.length - offset
    if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length)
      throw new Error("Malformed MP4 box size")
    boxes.push({ type, offset })
    offset += size
  }
  const moov = boxes.find((box) => box.type === "moov")
  const mdat = boxes.find((box) => box.type === "mdat")
  if (!moov || !mdat || moov.offset > mdat.offset)
    throw new Error("MP4 is missing faststart metadata")
}

export function assertGopFrames(frames, limit) {
  const keys = frames.flatMap((frame, index) => (frame.key_frame === 1 ? [index] : []))
  if (
    !frames.length ||
    keys[0] !== 0 ||
    keys.some((frame, index) => index > 0 && frame - keys[index - 1] > limit) ||
    frames.length - keys.at(-1) > limit
  )
    throw new Error(`Video exceeds the ${limit}-frame GOP contract`)
}

export function assertDuration(actual, expected, fps) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1 / fps)
    throw new Error(`Unexpected video duration: expected ${expected}s within one ${fps}fps frame`)
}
