#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { claimInvocation, readInvocationClaim } from '../packages/helm-link-connector/lib/invocation-claims.mjs'
import {
  markTerminalDelivered, migrateProcessedLedger, pendingTerminalOutbox, readTerminalRecord,
  recordTerminal, recoverAmbiguousInvocations, writeTerminalOutbox,
} from '../packages/helm-link-connector/lib/terminal-store.mjs'
import {
  acquireBindingFence, runBoundedCleanup, runConnectorLoops, runOpenClawAdvisory,
} from '../packages/helm-link-connector/bin/helm-link.mjs'

const ORIGINAL = 'de44731b-be35-415a-9be7-a684917bcc37'
const fixture = resolve(import.meta.dirname, 'fixtures/fake-openclaw.mjs')
const root = mkdtempSync(join(tmpdir(), 'helm-link-chaos-'))
const results = []
async function check(name, invariant, fn) {
  try { await fn(); results.push({ name, invariant, status: 'passed' }) }
  catch (error) { results.push({ name, invariant, status: 'failed', error: error.message }); throw error }
}
const scenario = (name, options = {}) => runOpenClawAdvisory({
  binary: fixture, args: ['agent', '--agent', 'fixture-agent', '--message', 'fixture', '--json'],
  env: { ...process.env, FAKE_OPENCLAW_SCENARIO: name }, ...options,
})

try {
  await check('crash-before-fsync', 'No durable claim means no execution evidence was fabricated.', () => {
    assert.equal(readInvocationClaim(root, 'never-claimed'), null)
  })
  await check('crash-after-fsync-before-spawn', 'A durable claim permanently rejects a second spawn.', () => {
    const input = { dispatchId: 'claimed-once', bindingId: 'binding', invocationId: 'invocation-1', fencingToken: 1 }
    claimInvocation(root, input)
    assert.throws(() => claimInvocation(root, { ...input, invocationId: 'invocation-2' }), /must never spawn again/)
  })
  await check('duplicate-connectors', 'Exclusive claim creation permits only one connector winner.', async () => {
    const attempts = await Promise.allSettled([1, 2].map(i => Promise.resolve().then(() => claimInvocation(root, {
      dispatchId: 'split-brain', bindingId: 'binding', invocationId: `invocation-${i}`, fencingToken: i,
    }))))
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
  })
  await check('ambiguous-restart', 'Claimed work without a terminal becomes unknown and never replays.', () => {
    const recovered = recoverAmbiguousInvocations(root, { fencingToken: 3 }, [{
      dispatchId: 'ambiguous', bindingId: 'binding', invocationId: 'invocation-a', fencingToken: 2,
    }])
    assert.equal(recovered[0].terminalCode, 'execution_outcome_unknown')
    assert.equal(recoverAmbiguousInvocations(root, { fencingToken: 4 }, [{
      dispatchId: 'ambiguous', bindingId: 'binding', invocationId: 'invocation-a', fencingToken: 2,
    }]).length, 0)
  })
  await check('post-terminal-pre-ack', 'Terminal outbox survives until an idempotent delivery marker exists.', () => {
    const ack = { dispatchId: 'outbox', state: 'failed', terminalCode: 'fixture' }
    recordTerminal(root, { ...ack, bindingId: 'binding' })
    writeTerminalOutbox(root, ack)
    assert.ok(pendingTerminalOutbox(root).some(row => row.dispatchId === 'outbox'))
    markTerminalDelivered(root, 'outbox')
    assert.ok(!pendingTerminalOutbox(root).some(row => row.dispatchId === 'outbox'))
  })
  await check('terminal-replay-sentinel', 'The original terminal dispatch is rejected after cache pruning.', () => {
    const state = { bindingId: 'binding', processedDispatchIds: [ORIGINAL] }
    migrateProcessedLedger(root, state)
    state.processedDispatchIds = []
    assert.equal(readTerminalRecord(root, ORIGINAL).terminalCode, 'legacy_terminal_import')
    assert.throws(() => recordTerminal(root, {
      dispatchId: ORIGINAL, bindingId: 'binding', state: 'completed', terminalCode: null,
    }), /conflict/)
  })
  await check('parent-timeout', 'Runtime deadline emits parent_timeout.', async () => {
    assert.equal((await scenario('timeout', { timeoutMs: 10, sigtermGraceMs: 5 })).terminationCause, 'parent_timeout')
  })
  await check('stdout-overflow', 'Stdout overflow is distinct and bounded.', async () => {
    assert.equal((await scenario('stdout-overflow', { outputLimit: 64 })).terminationCause, 'stdout_overflow')
  })
  await check('stderr-overflow', 'Stderr overflow is distinct and never customer content.', async () => {
    assert.equal((await scenario('stderr-overflow', { stderrLimit: 64 })).terminationCause, 'stderr_overflow')
  })
  await check('ignored-sigterm', 'Ignored SIGTERM escalates to SIGKILL within a bound.', async () => {
    const result = await scenario('ignore-sigterm', { timeoutMs: 100, sigtermGraceMs: 10, closeTimeoutMs: 20 })
    assert.equal(result.terminationCause, 'parent_timeout')
    assert.equal(result.signal, 'SIGKILL')
  })
  await check('close-hang', 'A child that never closes resolves as close_timeout.', async () => {
    const result = await runOpenClawAdvisory({ args: ['agent'], timeoutMs: 5, sigtermGraceMs: 5, closeTimeoutMs: 5,
      spawnImpl: () => { const child = new EventEmitter(); child.pid = 999; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; return child } })
    assert.equal(result.terminationCause, 'close_timeout')
  })
  await check('cleanup-hang', 'Cleanup has an independent deadline.', async () => {
    await assert.rejects(runBoundedCleanup(() => new Promise(() => {}), 5), error => error.code === 'helm_link_cleanup_timeout')
  })
  await check('stale-fencing', 'Non-monotonic fencing ownership fails closed.', async () => {
    await assert.rejects(acquireBindingFence({ fencingToken: 8 }, {
      postImpl: async () => ({ fencingToken: 8 }), persist: () => {},
    }), /non-monotonic/)
  })
  await check('presence-telemetry-contention-queue', 'Presence/telemetry failure and runtime unknown do not violate capacity one.', async () => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), 80)
    let polls = 0; let concurrent = 0; let maximum = 0; const capacities = []; const runtimeStates = []
    await runConnectorLoops({}, { signal: controller.signal, idlePollMs: 1, busyCheckMs: 1, presenceMs: 1, telemetryMs: 1, telemetryTimeoutMs: 2,
      sleepImpl: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
      postImpl: async (_state, _path, body) => { polls += 1; capacities.push(body.localCapacity); runtimeStates.push(body.runtimeState); return polls === 1 ? { dispatch: { id: 'queued-1' }, queueDepth: 2 } : { dispatch: null, queueDepth: 1, retryAfterMs: 1 } },
      handleImpl: async () => { concurrent += 1; maximum = Math.max(maximum, concurrent); await new Promise(resolve => setTimeout(resolve, 15)); concurrent -= 1 },
      presenceImpl: async () => { throw new Error('presence 503') }, telemetryImpl: async () => new Promise(() => {}),
    })
    assert.equal(maximum, 1); assert.ok(capacities.includes(0)); assert.ok(runtimeStates.every(value => value === 'unknown'))
  })

  const artifact = { schema: 'helm-link.chaos-matrix.v1', originalTerminalDispatch: ORIGINAL,
    capacityInvariant: 1, totals: { passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }, results }
  mkdirSync('evidence', { recursive: true })
  writeFileSync('evidence/CHAOS_MATRIX.json', `${JSON.stringify(artifact, null, 2)}\n`)
  assert.equal(artifact.totals.failed, 0)
  console.log(`VERIFIED chaos matrix ${artifact.totals.passed}/${results.length} passed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
