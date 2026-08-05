#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  markTerminalDelivered, migrateProcessedLedger, pendingTerminalOutbox, readTerminalRecord,
  recordTerminal, writeTerminalOutbox,
  recoverAmbiguousInvocations,
} from '../packages/helm-link-connector/lib/terminal-store.mjs'
import { prepareTerminalDelivery } from '../packages/helm-link-connector/bin/helm-link.mjs'

const ORIGINAL_TERMINAL_DISPATCH = 'de44731b-be35-415a-9be7-a684917bcc37'
const root = mkdtempSync(join(tmpdir(), 'helm-link-terminals-'))
try {
  const state = { bindingId: 'binding-fixture', processedDispatchIds: [ORIGINAL_TERMINAL_DISPATCH] }
  migrateProcessedLedger(root, state)
  state.processedDispatchIds = [] // simulate bounded-cache pruning
  const terminal = readTerminalRecord(root, ORIGINAL_TERMINAL_DISPATCH)
  assert.equal(terminal?.terminalCode, 'legacy_terminal_import')
  assert.throws(() => recordTerminal(root, {
    dispatchId: ORIGINAL_TERMINAL_DISPATCH,
    bindingId: 'binding-fixture',
    state: 'completed',
    terminalCode: null,
  }), /Terminal record conflict/)

  const ack = { dispatchId: ORIGINAL_TERMINAL_DISPATCH, state: 'failed', terminalCode: 'legacy_terminal_import' }
  writeTerminalOutbox(root, ack)
  assert.equal(pendingTerminalOutbox(root).length, 1)
  markTerminalDelivered(root, ORIGINAL_TERMINAL_DISPATCH)
  assert.equal(pendingTerminalOutbox(root).length, 0)
  assert.equal(readTerminalRecord(root, ORIGINAL_TERMINAL_DISPATCH)?.dispatchId, ORIGINAL_TERMINAL_DISPATCH)
  assert.equal(readTerminalRecord(root, ORIGINAL_TERMINAL_DISPATCH)?.invocationFencingToken, 0)
  const redelivered = prepareTerminalDelivery({ fencingToken: 10 }, {
    invocationFencingToken: 8,
    deliveryFencingToken: 9,
  })
  assert.equal(redelivered.invocationFencingToken, 8)
  assert.equal(redelivered.deliveryFencingToken, 10)

  const ambiguous = recoverAmbiguousInvocations(root, { fencingToken: 9 }, [{
    dispatchId: 'ambiguous-dispatch', bindingId: 'binding-fixture',
    invocationId: 'invocation-ambiguous', fencingToken: 8,
  }])
  assert.equal(ambiguous[0]?.terminalCode, 'execution_outcome_unknown')
  assert.equal(pendingTerminalOutbox(root)[0]?.recovery, true)
  assert.equal(pendingTerminalOutbox(root)[0]?.invocationFencingToken, 8)
  assert.equal(pendingTerminalOutbox(root)[0]?.deliveryFencingToken, 9)
  assert.equal(recoverAmbiguousInvocations(root, { fencingToken: 10 }, [{
    dispatchId: 'ambiguous-dispatch', bindingId: 'binding-fixture',
    invocationId: 'invocation-ambiguous', fencingToken: 8,
  }]).length, 0)
  console.log('VERIFIED original terminal dispatch remains absorbing after restart and cache pruning')
  console.log('VERIFIED durable terminal outbox delivery marker')
  console.log('VERIFIED ambiguous invocation becomes no-replay terminal exactly once')
} finally {
  rmSync(root, { recursive: true, force: true })
}
