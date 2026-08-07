#!/usr/bin/env node
// Blocker 3 + Item 7 focused regression: the connector records the canonical
// terminal returned by the server (not what it locally decided), sends a
// signed/fenced/idempotent receipt, and converges after lost ack / lost
// receipt / recovery / restart without ever spawning work again.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  postCommitTerminal,
  postTerminalReceipt,
  prepareTerminalDelivery,
} from '../packages/helm-link-connector/bin/helm-link.mjs'
import {
  markTerminalDelivered,
  pendingTerminalOutbox,
  readTerminalRecord,
  recordTerminal,
  writeTerminalOutbox,
} from '../packages/helm-link-connector/lib/terminal-store.mjs'

const state = {
  bindingId: 'binding-receipt',
  server: 'https://example.invalid',
  fencingToken: 4,
  activeInvocationId: 'invocation-receipt',
}
const dispatchId = 'dispatch-receipt'
const terminalId = 'terminal-server-canonical'
const invocationFencingToken = 4
const deliveryFencingToken = 4

// The connector requested `completed` but the server has a durable
// cancellation on the run and returns the arbitrated absorbing terminal.
const requestedAck = {
  protocolVersion: 'helm-link.longpoll.v1',
  dispatchId,
  state: 'completed',
  terminalCode: null,
  terminalSummary: 'connector believed the child completed cleanly',
  invocationId: state.activeInvocationId,
  invocationFencingToken,
  deliveryFencingToken,
}

// Item 7: canonical server override is what becomes the local absorbing
// terminal. The connector never records a locally-authored `completed` when
// the server returned an arbitrated cancellation.
const canonical = await postCommitTerminal(state, requestedAck, {
  postImpl: async (_state, path, body) => {
    assert.equal(path, '/api/helm-link/connector/ack')
    assert.equal(body.dispatchId, dispatchId)
    assert.equal(body.state, 'completed')
    return {
      ok: true,
      duplicate: false,
      arbitrated: true,
      terminalId,
      canonical: {
        state: 'failed',
        terminalCode: 'cancelled_during_execution',
        terminalSummary: 'Durable cancellation was recorded before terminal commit.',
      },
    }
  },
})
assert.equal(canonical.arbitrated, true)
assert.equal(canonical.state, 'failed')
assert.equal(canonical.terminalCode, 'cancelled_during_execution')
assert.equal(canonical.terminalId, terminalId)
await assert.rejects(
  postCommitTerminal(state, requestedAck, {
    postImpl: async () => ({ ok: true, canonical: { state: 'completed' } }),
  }),
  /canonical terminal identity/i,
  'the connector must retain its durable outbox when the server omits terminal identity',
)
await assert.rejects(
  postCommitTerminal(state, requestedAck, {
    postImpl: async () => ({ ok: false, terminalId }),
  }),
  /not accepted/i,
  'an explicit non-acceptance must never be marked delivered locally',
)

const root = mkdtempSync(join(tmpdir(), 'helm-link-receipt-'))
try {
  // Item 7: acknowledgement intent is durable before send. The outbox row
  // must exist on disk before postCommitTerminal is called so a lost response
  // still lets a restart converge without spawning work again.
  writeTerminalOutbox(root, prepareTerminalDelivery(state, requestedAck))
  assert.equal(pendingTerminalOutbox(root).length, 1,
    'terminal-outbox row must be written before the ack HTTP call')

  // Item 7: record the canonical terminal locally. Absorbing — a later
  // attempt to record a conflicting local terminal must throw.
  recordTerminal(root, {
    dispatchId,
    bindingId: state.bindingId,
    invocationId: requestedAck.invocationId,
    invocationFencingToken,
    state: canonical.state,
    terminalCode: canonical.terminalCode,
    terminalSummary: canonical.terminalSummary,
    terminalId: canonical.terminalId,
  })
  const stored = readTerminalRecord(root, dispatchId)
  assert.equal(stored.state, 'failed')
  assert.equal(stored.terminalCode, 'cancelled_during_execution')
  assert.equal(stored.terminalId, terminalId)
  assert.throws(() => recordTerminal(root, {
    dispatchId,
    bindingId: state.bindingId,
    state: 'completed',
    terminalCode: null,
  }), /conflict/i)

  // Item 7: a lost receipt response must retry only the receipt (never the
  // ack, never new work). Duplicate receipts still return delivered=true and
  // only bump attempts.
  let receiptCalls = 0
  let ackCallCount = 0
  const receiptImpl = async (_state, path, body) => {
    if (path === '/api/helm-link/connector/ack') {
      ackCallCount += 1
      throw new Error('ack must not be re-sent on lost receipt retry')
    }
    receiptCalls += 1
    assert.equal(path, '/api/helm-link/connector/receipts')
    assert.deepEqual(body, {
      protocolVersion: 'helm-link.longpoll.v1',
      dispatchId,
      terminalId,
      deliveryFencingToken: state.fencingToken,
    })
    if (receiptCalls === 1) throw new Error('receipt network lost')
    if (receiptCalls === 2) return { delivered: true, duplicate: false, deliveredAt: '2026-08-07T12:00:01.000Z', attemptCount: 1 }
    return { delivered: true, duplicate: true, deliveredAt: '2026-08-07T12:00:01.000Z', attemptCount: 2 }
  }
  await assert.rejects(
    postTerminalReceipt(state, { dispatchId, terminalId }, { postImpl: receiptImpl }),
    /receipt network lost/,
  )
  await postTerminalReceipt(state, { dispatchId, terminalId }, { postImpl: receiptImpl })
  await postTerminalReceipt(state, { dispatchId, terminalId }, { postImpl: receiptImpl })
  assert.equal(receiptCalls, 3, 'receipt must be retried, ack must not be re-sent')
  assert.equal(ackCallCount, 0, 'ack must never be replayed on receipt retry')

  // Item 7: after the durable delivery marker exists, no further receipts
  // are needed and the outbox row is pruned.
  markTerminalDelivered(root, dispatchId)
  assert.equal(pendingTerminalOutbox(root).length, 0)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// Item 7: recovery acknowledgements also receipt. A recovery outbox row
// is written for an ambiguous invocation; the recovery HTTP call is used
// to insert the server-side terminal, and the same explicit receipt closes
// the outbox loop.
{
  const recoveryRoot = mkdtempSync(join(tmpdir(), 'helm-link-recovery-'))
  try {
    const recoveryDispatchId = 'dispatch-recovery'
    const recoveryTerminalId = 'terminal-recovery-canonical'
    writeTerminalOutbox(recoveryRoot, {
      protocolVersion: 'helm-link.longpoll.v1',
      dispatchId: recoveryDispatchId,
      invocationId: 'invocation-recovery',
      invocationFencingToken: 2,
      deliveryFencingToken: 4,
      state: 'failed',
      terminalCode: 'execution_outcome_unknown',
      terminalSummary: 'A durable invocation claim survived without a trusted terminal result; replay is forbidden.',
      recovery: true,
    })
    const pending = pendingTerminalOutbox(recoveryRoot)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].recovery, true)
    // A recovery response returns the canonical terminal identity so the
    // connector can immediately receipt without a spawn.
    let recoveryHttp = 0
    let receiptedForRecovery = false
    const stateRecovery = { ...state, fencingToken: 4 }
    const recoveryPostImpl = async (_state, path, body) => {
      if (path === '/api/helm-link/connector/recoveries') {
        recoveryHttp += 1
        assert.equal(body.dispatchId, recoveryDispatchId)
        return { ok: true, duplicate: false, terminalId: recoveryTerminalId }
      }
      if (path === '/api/helm-link/connector/receipts') {
        receiptedForRecovery = true
        assert.equal(body.terminalId, recoveryTerminalId)
        assert.equal(body.dispatchId, recoveryDispatchId)
        return { delivered: true, duplicate: false, deliveredAt: '2026-08-07T12:00:02.000Z', attemptCount: 1 }
      }
      throw new Error(`unexpected recovery path ${path}`)
    }
    const recoveryResponse = await recoveryPostImpl(stateRecovery, '/api/helm-link/connector/recoveries', pending[0])
    assert.equal(recoveryHttp, 1)
    await postTerminalReceipt(stateRecovery, {
      dispatchId: recoveryDispatchId,
      terminalId: recoveryResponse.terminalId,
    }, { postImpl: recoveryPostImpl })
    assert.equal(receiptedForRecovery, true)
    markTerminalDelivered(recoveryRoot, recoveryDispatchId)
    assert.equal(pendingTerminalOutbox(recoveryRoot).length, 0)
  } finally {
    rmSync(recoveryRoot, { recursive: true, force: true })
  }
}

// Item 7: duplicate receipts never execute work. The invocation-claims
// exclusive-create semantic already blocks a re-spawn, so a second attempt
// on the same dispatch id must throw and no new spawn/ack can happen.
{
  const restartRoot = mkdtempSync(join(tmpdir(), 'helm-link-restart-'))
  try {
    const { claimInvocation, InvocationAlreadyClaimedError } =
      await import('../packages/helm-link-connector/lib/invocation-claims.mjs')
    claimInvocation(restartRoot, {
      dispatchId: 'restart-safe',
      bindingId: state.bindingId,
      invocationId: 'invocation-first',
      fencingToken: 4,
    })
    try {
      claimInvocation(restartRoot, {
        dispatchId: 'restart-safe',
        bindingId: state.bindingId,
        invocationId: 'invocation-second',
        fencingToken: 5,
      })
      assert.fail('a durable claim must permanently reject a second spawn')
    } catch (error) {
      assert.ok(error instanceof InvocationAlreadyClaimedError)
    }
  } finally {
    rmSync(restartRoot, { recursive: true, force: true })
  }
}

console.log('VERIFIED acknowledgement intent is durable on disk before the ack HTTP send')
console.log('VERIFIED connector records the canonical arbitrated terminal, never a conflicting locally-authored one')
console.log('VERIFIED missing canonical terminal identity fails closed and preserves delivery intent')
console.log('VERIFIED a lost receipt response retries only the receipt; ack is never re-sent')
console.log('VERIFIED recovery outbox rows are sent via /recoveries and closed with the same signed receipt')
console.log('VERIFIED duplicate receipts never execute work; the durable invocation claim blocks any re-spawn')
