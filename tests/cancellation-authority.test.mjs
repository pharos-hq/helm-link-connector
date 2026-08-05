#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyCancellationTerminal,
  requestGatewayCancellation,
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
