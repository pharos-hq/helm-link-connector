#!/usr/bin/env node
import assert from 'node:assert/strict'
import { runConnectorLoops } from '../packages/helm-link-connector/bin/helm-link.mjs'

const controller = new AbortController()
let polls = 0
let handled = 0
let presenceAttempts = 0
let concurrent = 0
let maxConcurrent = 0
const capacities = []
setTimeout(() => controller.abort(), 100)

await runConnectorLoops({}, {
  signal: controller.signal,
  idlePollMs: 2, busyCheckMs: 1, presenceMs: 2, telemetryMs: 2, telemetryTimeoutMs: 3,
  sleepImpl: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))),
  postImpl: async (_state, _path, body) => {
    polls += 1
    capacities.push(body.localCapacity)
    return polls === 1 && body.localCapacity === 1
      ? { dispatch: { id: 'dispatch-1' } }
      : { dispatch: null, retryAfterMs: 1 }
  },
  handleImpl: async () => {
    concurrent += 1
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await new Promise(resolve => setTimeout(resolve, 20))
    handled += 1
    concurrent -= 1
  },
  presenceImpl: async () => {
    presenceAttempts += 1
    throw new Error('fixture presence 503')
  },
  telemetryImpl: async () => new Promise(() => {}),
})

assert.ok(polls >= 2, `expected polling despite independent failures, saw ${polls}`)
assert.equal(handled, 1)
assert.equal(maxConcurrent, 1)
assert.ok(capacities.includes(0), 'poll must continue with zero capacity while execution is active')
assert.ok(presenceAttempts >= 2)
console.log('VERIFIED acquisition/execution/presence/telemetry failure isolation at capacity one')
