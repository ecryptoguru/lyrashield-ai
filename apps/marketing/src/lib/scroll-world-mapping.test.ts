import { describe, expect, it } from "vitest"
import { easeVideoTime, sampleScroll, validateBands } from "./scroll-world-mapping"
const bands = [
  { id: "gateway", start: 0, end: 8, top: 100, bottom: 900 },
  { id: "target", start: 8, end: 16, top: 900, bottom: 1700 },
] as const

describe("native scroll to continuous world time", () => {
  it("maps forward and reversed positions identically without a chapter reset", () => {
    expect(sampleScroll(500, bands)).toEqual({ chapter: "gateway", time: 4 })
    expect(sampleScroll(900, bands)).toEqual({ chapter: "target", time: 8 })
    expect(sampleScroll(899, bands).time).toBeCloseTo(7.99, 1)
    expect(sampleScroll(-10, bands).time).toBe(0)
    expect(sampleScroll(9999, bands).time).toBe(16)
  })
  it("rejects empty and overlapping geometry before enhancing", () => {
    expect(validateBands([])).toBe(false)
    expect(validateBands(bands)).toBe(true)
    expect(validateBands([bands[0], { ...bands[1], top: 800 }])).toBe(false)
  })
})

describe("video-only scroll easing", () => {
  it("spreads a wheel step over a bounded interval and reaches its exact target", () => {
    expect(easeVideoTime(10, 12, 0)).toBe(10)
    expect(easeVideoTime(10, 12, 45)).toBeGreaterThan(10)
    expect(easeVideoTime(10, 12, 45)).toBeLessThan(12)
    expect(easeVideoTime(10, 12, 180)).toBe(12)
    expect(easeVideoTime(10, 12, 900)).toBe(12)
  })
  it("reverses monotonically without overshoot", () => {
    const samples = Array.from({ length: 19 }, (_, i) => easeVideoTime(12, 8, i * 10))
    expect(samples.every((value, i) => value >= 8 && value <= (samples[i - 1] ?? 12))).toBe(true)
    expect(samples.at(-1)).toBe(8)
  })
})

it("keeps camera velocity continuous when chapter lengths differ", () => {
  const uneven = [
    { id: "gateway", start: 0, end: 8, top: 0, bottom: 3400 },
    { id: "target", start: 8, end: 16, top: 3400, bottom: 4075 },
    { id: "scan", start: 16, end: 24, top: 4075, bottom: 4750 },
  ]
  for (const boundary of [3400, 4075]) {
    const before = sampleScroll(boundary, uneven).time - sampleScroll(boundary - 0.1, uneven).time
    const after = sampleScroll(boundary + 0.1, uneven).time - sampleScroll(boundary, uneven).time
    expect(Math.abs(before - after)).toBeLessThan(0.00001)
  }
  let prior = 0
  for (let y = 0; y <= 4750; y++) {
    const time = sampleScroll(y, uneven).time
    expect(time).toBeGreaterThanOrEqual(prior)
    prior = time
  }
  expect(sampleScroll(3400, uneven).time).toBe(8)
  expect(sampleScroll(4075, uneven).time).toBe(16)
})
