#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyCancellationTerminal,
  requestGatewayCancellation,
  runConnectorLoops,
} from '../packages/helm-link-connector/bin/helm-link.mjs'
import { readTerminalRecord, recordTerminal } from '../packages/helm-link-connector/lib/terminal-store.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

const state = { runtimeAgentId: 'pharos_forge', bindingId: 'binding-test' }
const liveness = { activeGatewayRunId: 'run-cancel-race', cancellation: null }
const gateway = deferred()
const pending = requestGatewayCancellation(state, liveness, '2026-08-05T16:40:00Z', {
  cancelImpl: async () => gateway.promise,
})

// Intent must be visible synchronously, before Gateway or the original child settles.
assert.deepEqual(liveness.cancellation, {
  requested: true,
  requestedAt: '2026-08-05T16:40:00Z',
  resolved: false,
  cancelled: false,
  providerStarted: null,
})
assert.equal(classifyCancellationTerminal(liveness.cancellation).terminalCode, 'execution_outcome_unknown')

gateway.resolve({ cancelled: true, providerStarted: true })
const confirmed = await pending
assert.equal(confirmed.resolved, true)
assert.equal(classifyCancellationTerminal(confirmed).terminalCode, 'cancelled_during_execution')

const lostLiveness = { activeGatewayRunId: 'run-gateway-loss', cancellation: null }
const lost = await requestGatewayCancellation(state, lostLiveness, '2026-08-05T16:41:00Z', {
  cancelImpl: async () => { throw new Error('gateway disconnected') },
})
assert.equal(lost.resolved, true)
assert.equal(classifyCancellationTerminal(lost).terminalCode, 'execution_outcome_unknown')

// One absorbing terminal arbitrates cancel/complete and restart races.
const root = mkdtempSync(join(tmpdir(), 'helm-link-cancel-authority-'))
try {
  recordTerminal(root, {
    dispatchId: 'run-cancel-race',
    bindingId: state.bindingId,
    state: 'failed',
    terminalCode: classifyCancellationTerminal(confirmed).terminalCode,
  })
  assert.throws(() => recordTerminal(root, {
    dispatchId: 'run-cancel-race',
    bindingId: state.bindingId,
    state: 'completed',
    terminalCode: null,
  }), /conflict/)

  recordTerminal(root, {
    dispatchId: 'run-gateway-loss',
    bindingId: state.bindingId,
    state: 'failed',
    terminalCode: classifyCancellationTerminal(lost).terminalCode,
  })
  assert.equal(readTerminalRecord(root, 'run-gateway-loss')?.terminalCode, 'execution_outcome_unknown')
  assert.throws(() => recordTerminal(root, {
    dispatchId: 'run-gateway-loss',
    bindingId: state.bindingId,
    state: 'completed',
    terminalCode: null,
  }), /conflict/)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('VERIFIED cancellation intent precedes Gateway await and all races use one absorbing terminal path')

// Exact staging regression: the dispatch is claimed, ordinary request budget
// is exhausted, but the independently governed cancellation control path still
// reaches Gateway and produces the absorbing pre-provider terminal decision.
{
  const controller = new AbortController()
  let ordinaryCalls = 0
  let ordinaryRateLimits = 0
  let controlCalls = 0
  let cancelCalls = 0
  let terminalCode = null
  const observedDispatchId = 'run-rate-starvation-regression'
  const loopState = { ...state, fencingToken: 1 }
  await runConnectorLoops(loopState, {
    signal: controller.signal,
    idlePollMs: 1,
    busyCheckMs: 1,
    presenceMs: 1,
    telemetryMs: 1,
    cancellationMs: 1,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))),
    postImpl: async (_state, pathname) => {
      ordinaryCalls += 1
      if (pathname === '/api/helm-link/connector/poll' && ordinaryCalls === 1) {
        return { dispatch: { id: observedDispatchId }, queueDepth: 1 }
      }
      ordinaryRateLimits += 1
      const error = new Error('Connector rate limit exceeded.')
      error.status = 429
      throw error
    },
    controlPostImpl: async (_state, pathname, body) => {
      controlCalls += 1
      assert.equal(pathname, '/api/helm-link/connector/cancellations')
      assert.equal(body.dispatchId, observedDispatchId)
      return { cancellation: { requestedAt: '2026-08-05T20:24:00Z' } }
    },
    cancelImpl: async (_state, runId) => {
      cancelCalls += 1
      assert.equal(runId, observedDispatchId)
      return { cancelled: true, providerStarted: false }
    },
    handleImpl: async (_state, dispatch, active) => {
      active.activeDispatchId = dispatch.id
      active.activeGatewayRunId = dispatch.id
      const deadline = Date.now() + 1_000
      while (!active.cancellation?.resolved && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      assert.equal(active.cancellation?.cancelled, true)
      terminalCode = classifyCancellationTerminal(active.cancellation).terminalCode
      controller.abort()
    },
    presenceImpl: async () => {},
    telemetryImpl: async () => ({ runtimeState: 'unknown' }),
  })
  assert.ok(ordinaryRateLimits > 0, 'ordinary request budget must be exhausted')
  assert.ok(controlCalls > 0, 'reserved cancellation control path must remain available')
  assert.equal(cancelCalls, 1)
  assert.equal(terminalCode, 'cancelled_before_provider')
}

console.log('VERIFIED claim -> durable cancellation -> ordinary 429 -> reserved delivery -> absorbing terminal')
