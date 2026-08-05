#!/usr/bin/env node

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  advisoryArgs,
  extractStructuredModel,
  extractStructuredText,
  buildLaunchdPlist,
  deriveLivenessPresence,
  postJson,
  runOpenClawAdvisory,
  registerInvocationClaim,
  acquireBindingFence,
  runBoundedCleanup,
} from '../packages/helm-link-connector/bin/helm-link.mjs'

const plist = buildLaunchdPlist({
  wrapper: '/Users/test user/.helm-link/run&supervised.sh',
  node: '/opt/homebrew/bin/node',
  connector: '/Users/test user/.helm-link/helm-link.mjs',
  stateDir: '/Users/test user/.helm-link',
  openclaw: '/opt/homebrew/bin/openclaw',
  stdout: '/Users/test user/.helm-link/logs/out.log',
  stderr: '/Users/test user/.helm-link/logs/err.log',
})
assert.match(plist, /<string>com\.pharos\.helm-link<\/string>/)
assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/)
assert.match(plist, /run&amp;supervised\.sh/)
assert.doesNotMatch(plist, /KeepAlive<\/key><true\/>/)

const root = resolve(import.meta.dirname, '..')
const fixture = join(root, 'tests/fixtures/fake-openclaw.mjs')
chmodSync(fixture, 0o755)

const invocation = advisoryArgs('fixture-agent', 'binding-123', 'safe advisory text', { noToolsAttested: true })
try {
  assert.ok(invocation.args.includes('--json'), 'agent invocation must require structured JSON')
} finally {
  invocation.cleanup()
}

const actualEnvelope = JSON.stringify({
  runId: '00000000-0000-4000-8000-000000000001',
  status: 'ok',
  summary: 'completed',
  result: {
    payloads: [{ text: 'HELM-LINK-083-ACCEPTED' }],
    meta: {
      agentMeta: { model: 'openai/gpt-5.6-sol' },
      finalAssistantVisibleText: 'ignored mirror',
      finalAssistantRawText: 'ignored raw mirror',
    },
  },
})
assert.equal(extractStructuredText(actualEnvelope), 'HELM-LINK-083-ACCEPTED')
assert.equal(extractStructuredModel(actualEnvelope), 'openai/gpt-5.6-sol')

const structured = await runScenario('structured')
assert.equal(structured.code, 0)
assert.equal(structured.timedOut, false)
assert.equal(extractStructuredText(structured.stdout), 'structured customer response')
assert.equal(extractStructuredModel(structured.stdout), 'openai/gpt-fixture')
assert.equal(structured.terminationCause, 'completed')
assert.equal(structured.stdoutBytes, Buffer.byteLength(structured.stdout))
assert.equal(structured.stderrBytes, 0)
assert.equal(structured.stdoutTruncated, false)
assert.equal(structured.stderrTruncated, false)

const malformed = await runScenario('malformed')
assert.equal(malformed.code, 0)
assert.equal(extractStructuredText(malformed.stdout), '')

const nonzero = await runScenario('nonzero')
assert.equal(nonzero.code, 9)
assert.equal(nonzero.terminationCause, 'nonzero_exit')
assert.equal(extractStructuredText(nonzero.stdout), '')

const timedOut = await runScenario('timeout', 50)
assert.equal(timedOut.timedOut, true)
assert.equal(timedOut.terminationCause, 'parent_timeout')

const stdoutOverflow = await runScenario('stdout-overflow', 2000, { outputLimit: 64 })
assert.equal(stdoutOverflow.terminationCause, 'stdout_overflow')
assert.equal(stdoutOverflow.stdoutTruncated, true)
const stderrOverflow = await runScenario('stderr-overflow', 2000, { stderrLimit: 64 })
assert.equal(stderrOverflow.terminationCause, 'stderr_overflow')
assert.equal(stderrOverflow.stderrTruncated, true)

const neverCloses = await runOpenClawAdvisory({
  args: ['agent'], timeoutMs: 5, sigtermGraceMs: 5, closeTimeoutMs: 5,
  spawnImpl: () => {
    const child = new EventEmitter()
    child.pid = 999
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    return child
  },
})
assert.equal(neverCloses.terminationCause, 'close_timeout')
await assert.rejects(runBoundedCleanup(() => new Promise(() => {}), 5),
  (error) => error?.code === 'helm_link_cleanup_timeout')
const spawnError = await runOpenClawAdvisory({ args: ['agent'], binary: '/definitely/missing/openclaw' })
assert.equal(spawnError.terminationCause, 'spawn_error')
assert.equal(extractStructuredText(timedOut.stdout), '')

const zeroContent = await runScenario('zero-content')
assert.equal(zeroContent.code, 0)
assert.equal(extractStructuredText(zeroContent.stdout), '')
assert.ok(!extractStructuredText(zeroContent.stdout).includes('must not escape'))

assert.equal(extractStructuredText('{"status":"ok","result":{"payloads":"not-an-array"}}'), '')
assert.equal(extractStructuredText('raw stdout that resembles customer content'), '')

assert.equal(deriveLivenessPresence({ lastPollCompletedAt: 0 }), 'degraded')
assert.equal(deriveLivenessPresence({
  lastPollCompletedAt: 100_000,
  lastDispatchProgressAt: 0,
  pollStartedAt: 0,
}, 100_001), 'online')
assert.equal(deriveLivenessPresence({
  lastPollCompletedAt: 1,
  lastDispatchProgressAt: 0,
  pollStartedAt: 0,
}, 90_001), 'degraded')

const pair = generateKeyPairSync('ed25519')
await assert.rejects(
  postJson({
    server: 'https://example.invalid',
    bindingId: '00000000-0000-4000-8000-000000000001',
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }, '/hung', {}, {
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }),
  }),
  (error) => error?.code === 'helm_link_request_timeout',
)

let registered = null
await registerInvocationClaim({ bindingId: 'binding-fixture' }, {
  dispatchId: 'dispatch-fixture',
  invocationId: 'invocation-fixture',
  fencingToken: 4,
}, {
  postImpl: async (_state, path, body) => {
    registered = { path, body }
    return { accepted: true }
  },
})
assert.deepEqual(registered, {
  path: '/api/helm-link/connector/claims',
  body: {
    protocolVersion: 'helm-link.longpoll.v1',
    dispatchId: 'dispatch-fixture',
    invocationId: 'invocation-fixture',
    fencingToken: 4,
  },
})

const fencedState = { fencingToken: 3 }
assert.equal(await acquireBindingFence(fencedState, {
  postImpl: async () => ({ fencingToken: 4, issuedAt: '2026-08-05T14:00:00.000Z' }),
  persist: () => {},
}), 4)
assert.equal(fencedState.fencingToken, 4)
await assert.rejects(
  acquireBindingFence(fencedState, { postImpl: async () => ({ fencingToken: 4 }), persist: () => {} }),
  /non-monotonic fencing token/,
)
await assert.rejects(
  postJson({
    server: 'https://example.invalid',
    bindingId: '00000000-0000-4000-8000-000000000001',
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }, '/stalled-body', {}, {
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => Promise.resolve({
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
    }),
  }),
  (error) => error?.code === 'helm_link_request_timeout',
)

console.log('VERIFIED OpenClaw 2026.7.1 structured-output contract')
console.log('VERIFIED malformed, non-zero, timeout, and zero-content fail closed')
console.log('VERIFIED bounded HTTP headers/body and data-plane-derived presence')
console.log('VERIFIED typed termination diagnostics and independent stdout/stderr counters')
console.log('VERIFIED local claim is registered with server before spawn')
console.log('VERIFIED connector acquires and persists monotonic fencing ownership')
console.log('VERIFIED timeout, overflow, signal escalation, close, and cleanup bounds')

async function runScenario(scenario, timeoutMs = 2000, options = {}) {
  return runOpenClawAdvisory({
    binary: fixture,
    args: ['agent', '--agent', 'fixture-agent', '--message', 'fixture', '--json'],
    timeoutMs,
    env: { ...process.env, FAKE_OPENCLAW_SCENARIO: scenario },
    ...options,
  })
}
