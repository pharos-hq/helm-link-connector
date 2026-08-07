#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mapTerminalConnectorError, runConnectorLoops } from '../packages/helm-link-connector/bin/helm-link.mjs'

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

for (const terminalError of [
  Object.assign(new Error('Binding is revoked.'), { status: 403 }),
  Object.assign(new Error('Binding is gone.'), { status: 410 }),
  new Error('revoked binding sentinel'),
]) {
  const state = { status: 'paired' }
  let persisted = null
  const mapped = mapTerminalConnectorError(terminalError, state, {
    persist: (next) => { persisted = { ...next } },
  })
  assert.equal(mapped.exitCode, 75)
  assert.equal(state.status, 'revoked')
  assert.equal(persisted?.status, 'revoked')
  assert.match(state.revokedAt, /^\d{4}-\d{2}-\d{2}T/)
}

const transient = new Error('fixture transient failure')
assert.equal(mapTerminalConnectorError(transient, { status: 'paired' }, {
  persist: () => assert.fail('transient errors must not persist revocation'),
}), transient)

const terminalRoot = mkdtempSync(join(tmpdir(), 'helm-link-terminal-revocation-'))
const terminalServer = createServer((_request, response) => {
  response.writeHead(403, { 'content-type': 'application/json' })
  response.end('{"error":"Binding is revoked."}')
})
await new Promise((resolve, reject) => {
  terminalServer.once('error', reject)
  terminalServer.listen(0, '127.0.0.1', resolve)
})
try {
  const address = terminalServer.address()
  assert.ok(address && typeof address !== 'string')
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(join(terminalRoot, 'state.json'), JSON.stringify({
    server: `http://127.0.0.1:${address.port}`,
    bindingId: '00000000-0000-4000-8000-000000000075',
    runtimeAgentId: 'fixture-agent',
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    status: 'paired',
  }), { mode: 0o600 })
  const child = spawn(process.execPath, [
    resolve('packages/helm-link-connector/bin/helm-link.mjs'), 'run',
  ], {
    env: { ...process.env, HELM_LINK_STATE_DIR: terminalRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  assert.equal(exitCode, 75, stderr)
  assert.equal(JSON.parse(readFileSync(join(terminalRoot, 'state.json'), 'utf8')).status, 'revoked')
} finally {
  await new Promise((resolveClose) => terminalServer.close(resolveClose))
  rmSync(terminalRoot, { recursive: true, force: true })
}
console.log('VERIFIED acquisition/execution/presence/telemetry failure isolation at capacity one')
console.log('VERIFIED owner revocation persists terminal state and preserves exit 75')
