#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleDispatch,
  inspectOpenClawAgentHelp,
  operationalArgs,
  preflightOpenClawAgentCompatibility,
  sanitizeRuntimeError,
} from '../packages/helm-link-connector/bin/helm-link.mjs'

const dispatchId = '36740a5e-ae40-4542-abe7-b3d35caf9617'
const bindingId = '00000000-0000-4000-8000-000000000081'
const contract = {
  kind: 'run',
  capabilities: ['analysis'],
  deadlineMs: 30_000,
  progress: 'durable-events',
  cancellation: 'terminal-no-replay',
  output: 'durable-terminal',
}

const invocation = operationalArgs(
  'forge', bindingId, dispatchId, 'Return the FT-081 durable Run marker.', contract,
  new Date(Date.now() + 60_000).toISOString(),
)
try {
  assert.deepEqual(invocation.args.slice(0, 5), ['agent', '--agent', 'forge', '--session-key', `agent:forge:helm-run:${bindingId}:${dispatchId}`])
  assert.ok(invocation.args.includes('--message-file'))
  assert.ok(invocation.args.includes('--timeout'))
  assert.ok(invocation.args.includes('--json'))
  assert.ok(!invocation.args.includes('--run-id'))
  assert.ok(!invocation.args.includes('--queue-deadline-at'))
  assert.ok(!invocation.args.includes('--execution-timeout-ms'))
  assert.equal(invocation.executionTimeoutMs, 30_000)
  assert.ok(invocation.queueDeadlineAt > Date.now())
} finally {
  invocation.cleanup()
}

const supportedHelp = `Usage: openclaw agent [options]
  --agent <id>
  --json
  --message-file <path>
  --session-key <key>
  --timeout <seconds>`
assert.deepEqual(inspectOpenClawAgentHelp(supportedHelp).missing, [])
assert.equal((await preflightOpenClawAgentCompatibility({
  runImpl: async ({ args }) => {
    assert.deepEqual(args, ['agent', '--help'])
    return { terminationCause: 'completed', stdout: supportedHelp, stderr: '' }
  },
})).compatible, true)
await assert.rejects(
  preflightOpenClawAgentCompatibility({
    runImpl: async () => ({ terminationCause: 'completed', stdout: 'Usage: openclaw agent --agent <id>', stderr: '' }),
  }),
  /missing required options.*--message-file.*--session-key.*--timeout.*--json/,
)

assert.equal(
  sanitizeRuntimeError("error: unknown option '--run-id'\nGITHUB_PAT=secretvalue"),
  "error: unknown option '--run-id' GITHUB_PAT=[redacted]",
)

const root = mkdtempSync(join(tmpdir(), 'helm-link-ft-081-'))
const events = []
const acknowledgements = []
try {
  await handleDispatch({
    tenantId: 'tenant-ft-081',
    bindingId,
    runtimeAgentId: 'forge',
    fencingToken: 11,
    pendingAcks: {},
    eventStateByDispatch: {},
  }, {
    id: dispatchId,
    messageId: '00000000-0000-4000-8000-000000000082',
    payload: { kind: 'run', text: 'Return the FT-081 durable Run marker.', contract },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, {}, {
    root,
    lifecycleFile: join(root, 'lifecycle.ndjson'),
    registerClaimImpl: async () => ({ ok: true }),
    postEventImpl: async (_state, prepared) => { events.push(prepared.event) },
    acknowledgeImpl: async (_state, _dispatch, acknowledgement) => { acknowledgements.push(acknowledgement) },
    runImpl: async () => ({
      terminationCause: 'nonzero_exit',
      code: 1,
      signal: null,
      stdout: '',
      stderr: "error: unknown option '--run-id'\nGITHUB_PAT=secretvalue",
      stdoutBytes: 0,
      stderrBytes: 58,
    }),
  })
  assert.equal(acknowledgements.length, 1)
  assert.equal(acknowledgements[0].terminalCode, 'openclaw_nonzero_exit')
  assert.match(acknowledgements[0].terminalSummary, /unknown option '--run-id'/)
  assert.match(acknowledgements[0].terminalSummary, /GITHUB_PAT=\[redacted\]/)
  assert.doesNotMatch(acknowledgements[0].terminalSummary, /secretvalue/)
  assert.match(events.at(-1).body.text, /unknown option '--run-id'/)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('VERIFIED FT-081 uses only OpenClaw 2026.7.1-supported durable Run arguments')
console.log('VERIFIED dispatch identity and deadline enforcement remain connector-owned')
console.log('VERIFIED compatibility preflight and sanitized runtime failure evidence')
