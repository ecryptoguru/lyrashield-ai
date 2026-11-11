#!/usr/bin/env node
// Local Redis command model. Production Lua is separately reviewed, not evaluated here.
import { readFileSync, writeFileSync } from "node:fs"
import {
  OWNED_HOLD_LUA,
  SCAN_ADMISSION_KEY,
} from "../../../../ops/monitoring/paired-release-hold.mjs"

if (process.env.FAKE_REDIS_FAILURE === "1") process.exit(1)
const stateFile = process.env.FAKE_REDIS_STATE
let state = JSON.parse(readFileSync(stateFile, "utf8"))
const args = process.argv.slice(2)
const index = args.findIndex((arg) => ["SET", "GET", "EVAL"].includes(arg))
const [command, ...values] = args.slice(index)
let result = ""
if (command === "SET") {
  const [key, value, nx] = values
  if (key !== SCAN_ADMISSION_KEY || nx !== "NX") throw new Error("Unsafe SET")
  if (state.value === null) {
    state = { value, ttl: -1 }
    result = "OK"
  }
} else if (command === "GET") {
  if (values[0] !== SCAN_ADMISSION_KEY) throw new Error("Wrong key")
  result = state.value ?? ""
} else if (command === "EVAL") {
  const [lua, keys, key, operation, receipt] = values
  if (keys !== "1" || key !== SCAN_ADMISSION_KEY) throw new Error("Wrong CAS key")
  if (process.env.FAKE_REDIS_REPLACEMENT)
    state = { value: process.env.FAKE_REDIS_REPLACEMENT, ttl: -1 }
  result = "0"
  if (lua === OWNED_HOLD_LUA) {
    if (operation === "claim" && state.value === null) {
      state = { value: receipt, ttl: -1 }
      result = "1"
    } else if (state.value === receipt && state.ttl === -1) {
      if (operation === "release") state.value = null
      if (["claim", "assert", "release"].includes(operation)) result = "1"
    }
  } else {
    if (
      !lua.includes("raw ~= ARGV[2]") ||
      !lua.includes("count ~= 3") ||
      !lua.includes("value.operator ~= ARGV[1]") ||
      !lua.includes("value.stoppedAt:match")
    ) {
      throw new Error("Unsafe legacy resume")
    }
    try {
      const value = JSON.parse(state.value)
      if (
        value &&
        state.value === receipt &&
        JSON.stringify(value) === state.value &&
        Object.keys(value).sort().join(",") === "operator,reason,stoppedAt" &&
        typeof value.operator === "string" &&
        value.operator.length > 0 &&
        value.operator === operation &&
        typeof value.reason === "string" &&
        value.reason.length > 0 &&
        typeof value.stoppedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.stoppedAt) &&
        new Date(value.stoppedAt).toISOString() === value.stoppedAt
      ) {
        state.value = null
        result = "1"
      }
    } catch {
      /* A malformed stop must remain stopped. */
    }
  }
} else {
  throw new Error("Unexpected Redis command")
}
writeFileSync(stateFile, JSON.stringify(state))
console.log(result)
