#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleDispatch } from '../packages/helm-link-connector/bin/helm-link.mjs'
import { recordTerminal } from '../packages/helm-link-connector/lib/terminal-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'helm-link-post-claim-'))
const dispatch = {
  id: randomUUID(),
  messageId: randomUUID(),
  payload: { kind: 'chat', text: 'A harmless founder chat message.' },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}
const state = {
  bindingId: randomUUID(),
  runtimeAgentId: 'forge',
  fencingToken: 7,
  advisoryNoToolsAttested: false,
  pendingAcks: {},
  eventStateByDispatch: {},
}
const liveness = {}
const events = []
const acknowledgements = []

try {
  await handleDispatch(state, dispatch, liveness, {
    root,
    lifecycleFile: join(root, 'lifecycle.ndjson'),
    registerClaimImpl: async () => ({ ok: true }),
    advisoryArgsImpl: () => { throw new Error('fixture admission rejection') },
    postEventImpl: async (_state, prepared) => { events.push(prepared.event) },
    acknowledgeImpl: async (_state, _dispatch, acknowledgement) => {
      acknowledgements.push(acknowledgement)
      recordTerminal(root, {
        dispatchId: dispatch.id,
        bindingId: state.bindingId,
        invocationId: state.activeInvocationId,
        invocationFencingToken: state.fencingToken,
        ...acknowledgement,
      })
    },
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'error')
  assert.equal(acknowledgements.length, 1)
  assert.equal(acknowledgements[0].state, 'failed')
  assert.equal(acknowledgements[0].terminalCode, 'helm_link_chat_admission_failed')
  assert.match(acknowledgements[0].terminalSummary, /fixture admission rejection/)
  assert.equal(liveness.activeDispatchId, null)
  assert.equal(state.activeInvocationId, undefined)

  // The local absorbing terminal fences a second handling attempt.
  await handleDispatch(state, dispatch, liveness, { root })
  assert.equal(acknowledgements.length, 1)
  assert.equal(events.length, 1)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('VERIFIED every post-claim admission failure emits one durable terminal and cannot replay')
