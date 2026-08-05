#!/usr/bin/env node

import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const openclawRoot = process.env.OPENCLAW_REAL_ROOT
if (!openclawRoot) throw new Error('OPENCLAW_REAL_ROOT is required for the real-Gateway regression.')
const openclawEntry = resolve(openclawRoot, 'openclaw.mjs')
const connectorEntry = resolve(import.meta.dirname, '../packages/helm-link-connector/bin/helm-link.mjs')
const root = mkdtempSync(join(tmpdir(), 'helm-link-real-gateway-'))
const home = join(root, 'home')
const gatewayState = join(root, 'gateway-state')
const workspace = join(root, 'workspace')
const config = join(root, 'openclaw.json')
const wrapper = join(root, 'openclaw-wrapper.sh')
const model = process.env.OPENCLAW_REAL_MODEL || 'ollama/qwen3.6:35b-a3b'
const modelId = model.split('/').slice(1).join('/')

writeFileSync(join(root, 'placeholder'), '')
await import('node:fs/promises').then(({ mkdir }) => Promise.all([
  mkdir(home, { recursive: true, mode: 0o700 }),
  mkdir(gatewayState, { recursive: true, mode: 0o700 }),
  mkdir(workspace, { recursive: true, mode: 0o700 }),
]))
writeFileSync(join(workspace, 'AGENTS.md'), '# Real cancellation probe\nDo not use tools. Continue generating detailed prose until cancelled.\n', { mode: 0o600 })

const gatewayPort = await freePort()
writeFileSync(config, JSON.stringify({
  models: { mode: 'merge', providers: { ollama: {
    baseUrl: 'http://127.0.0.1:11434', api: 'ollama', apiKey: 'ollama-local',
    models: [{ id: modelId, name: modelId, input: ['text'], contextWindow: 32768, maxTokens: 4096 }],
  } } },
  agents: {
    defaults: { workspace, model: { primary: model, fallbacks: [] }, timeoutSeconds: 300 },
    list: [{ id: 'cancel_probe', default: true, workspace, model, tools: { profile: 'minimal' } }],
  },
  gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'none' } },
  channels: {}, messages: { visibleReplies: 'automatic' },
}, null, 2), { mode: 0o600 })
writeFileSync(wrapper, `#!/bin/sh\nexport HOME=${shell(home)}\nexport OPENCLAW_STATE_DIR=${shell(gatewayState)}\nexport OPENCLAW_CONFIG_PATH=${shell(config)}\nexport OPENCLAW_GATEWAY_PORT=${gatewayPort}\nexport OLLAMA_API_KEY=ollama-local\nexec ${shell(process.execPath)} ${shell(openclawEntry)} "$@"\n`, { mode: 0o700 })
chmodSync(wrapper, 0o700)

const gateway = spawn(process.execPath, [openclawEntry, 'gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback', '--auth', 'none', '--verbose'], {
  cwd: openclawRoot,
  env: { ...process.env, HOME: home, OPENCLAW_STATE_DIR: gatewayState, OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_GATEWAY_PORT: String(gatewayPort), OLLAMA_API_KEY: 'ollama-local', NO_COLOR: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let gatewayLog = ''
gateway.stdout.on('data', (chunk) => { gatewayLog += chunk.toString() })
gateway.stderr.on('data', (chunk) => { gatewayLog += chunk.toString() })
await waitFor(() => gatewayLog.includes('[gateway] ready'), 30_000, 'Gateway readiness')

const completed = await runScenario({ name: 'authoritative', killGatewayOnCancel: false })
assert.match(completed.terminalCode, /^cancelled_(before_provider|during_execution)$/)
assert.notEqual(completed.state, 'completed')
assert.ok(completed.ordinaryRateLimits > 0)
assert.equal(completed.sameRunIds, true)
assert.deepEqual(completed.lifecycleKinds.slice(0, 4), [
  'cancellation_request_observed',
  'gateway_cancel_request_started',
  'gateway_cancel_response',
  'execution_process_settled',
])
assert.equal(completed.lifecycleKinds.at(-1), 'cancellation_terminal_selected')

const duplicate = await runGatewayCall('agent.cancel', {
  runId: completed.runId,
  agentId: 'cancel_probe',
  sessionKey: completed.sessionKey,
})
assert.equal(duplicate.cancelled, false)
assert.equal(duplicate.status, 'not_active')

const lost = await runScenario({ name: 'gateway-loss', killGatewayOnCancel: true })
assert.equal(lost.terminalCode, 'execution_outcome_unknown')
assert.notEqual(lost.state, 'completed')
assert.ok(lost.ordinaryRateLimits > 0)
assert.equal(lost.sameRunIds, true)

gateway.kill('SIGTERM')
await waitExit(gateway, 10_000)

console.log(JSON.stringify({
  verdict: 'PASS',
  gatewayIdentity: firstLine(gatewayLog, /OpenClaw /),
  authoritative: completed,
  duplicateCancellation: { status: duplicate.status, cancelled: duplicate.cancelled },
  gatewayLoss: lost,
}, null, 2))

async function runScenario({ name, killGatewayOnCancel }) {
  const runId = `real-gateway-${name}-${randomUUID()}`
  const bindingId = `binding-${name}`
  const sessionKey = `agent:cancel_probe:helm-run:${bindingId}:${runId}`
  const stateDir = join(root, `connector-${name}`)
  await import('node:fs/promises').then(({ mkdir }) => mkdir(stateDir, { recursive: true, mode: 0o700 }))
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    server: 'http://127.0.0.1:0', bindingId, tenantId: 'tenant-probe', helmAgentId: 'helm-probe',
    runtimeAgentId: 'cancel_probe', keyId: `probe-${name}`,
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    processedDispatchIds: [], eventStateByDispatch: {}, status: 'paired', advisoryNoToolsAttested: true,
  }), { mode: 0o600 })

  let pollCount = 0
  let claimAt = 0
  let cancellationSent = false
  let ordinaryRateLimits = 0
  let ack
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url === '/api/helm-link/connector/ownership') return send(200, { fencingToken: 1, issuedAt: new Date().toISOString() })
    if (req.url === '/api/helm-link/connector/claims') { claimAt = Date.now(); return send(200, { ok: true }) }
    if (req.url === '/api/helm-link/connector/poll') {
      pollCount += 1
      if (pollCount === 1) return send(200, { dispatch: {
        id: runId, messageId: `message-${name}`, expiresAt: new Date(Date.now() + 30_000).toISOString(),
        payload: { kind: 'run', text: 'Write a detailed 10000-word technical essay about distributed systems. Do not stop early.',
          contract: { kind: 'run', capabilities: ['research'], deadlineMs: 30_000,
            progress: 'durable-events', cancellation: 'terminal-no-replay', output: 'durable-terminal' } },
      }, queueDepth: 1 })
      ordinaryRateLimits += 1
      return send(429, { error: 'ordinary traffic intentionally rate limited' })
    }
    if (req.url === '/api/helm-link/connector/cancellations') {
      if (claimAt && Date.now() - claimAt >= 1_500) {
        if (!cancellationSent && killGatewayOnCancel) setTimeout(() => gateway.kill('SIGTERM'), 25)
        cancellationSent = true
        return send(200, { cancellation: { requestedAt: new Date(claimAt + 1_500).toISOString() } })
      }
      return send(200, { cancellation: null })
    }
    if (req.url === '/api/helm-link/connector/ack') { ack = body; return send(200, { ok: true }) }
    if (req.url === '/api/helm-link/connector/events' || req.url === '/api/helm-link/connector/presence' ||
        req.url === '/api/helm-link/connector/recoveries') return send(200, { ok: true })
    return send(404, { error: 'not found' })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
  state.server = `http://127.0.0.1:${port}`
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state), { mode: 0o600 })

  const connector = spawn(process.execPath, [connectorEntry, 'run'], {
    env: { ...process.env, HOME: home, HELM_LINK_STATE_DIR: stateDir, HELM_LINK_OPENCLAW_BIN: wrapper, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let connectorLog = ''
  connector.stdout.on('data', (chunk) => { connectorLog += chunk.toString() })
  connector.stderr.on('data', (chunk) => { connectorLog += chunk.toString() })
  try {
    await waitFor(() => Boolean(ack), 90_000, `${name} terminal acknowledgement`)
  } catch (error) {
    writeFileSync(join(root, `${name}-connector.log`), connectorLog, { mode: 0o600 })
    writeFileSync(join(root, `${name}-gateway.log`), gatewayLog, { mode: 0o600 })
    throw error
  }
  connector.kill('SIGTERM')
  await waitExit(connector, 10_000)
  await new Promise((resolveClose) => server.close(resolveClose))
  const lifecycle = readFileSync(join(stateDir, 'lifecycle.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const relevant = lifecycle.filter((entry) => [
    'cancellation_request_observed', 'gateway_cancel_request_started', 'gateway_cancel_response',
    'gateway_cancel_error', 'execution_process_settled', 'cancellation_terminal_selected',
  ].includes(entry.kind))
  const runIds = relevant.map((entry) => entry.gatewayRunId).filter(Boolean)
  return {
    runId, sessionKey, state: ack.state, terminalCode: ack.terminalCode,
    ordinaryRateLimits, sameRunIds: runIds.length > 0 && runIds.every((value) => value === runId),
    lifecycleKinds: relevant.map((entry) => entry.kind),
    lifecycle: relevant.map((entry) => ({ kind: entry.kind, at: entry.at, gatewayRunId: entry.gatewayRunId,
      gatewayStatus: entry.gatewayStatus, gatewayStopReason: entry.gatewayStopReason,
      gatewayCancelled: entry.gatewayCancelled, providerStarted: entry.providerStarted,
      terminalCode: entry.terminalCode })),
    connectorErrorsRedacted: connectorLog.split('\n').filter((line) => /failed|error/i.test(line)).slice(-8),
  }
}

async function runGatewayCall(method, params) {
  const child = spawn(process.execPath, [openclawEntry, 'gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--timeout', '5000'], {
    cwd: openclawRoot,
    env: { ...process.env, HOME: home, OPENCLAW_STATE_DIR: gatewayState, OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_GATEWAY_PORT: String(gatewayPort), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const code = await waitExit(child, 10_000)
  if (code !== 0) throw new Error(`Gateway call failed: ${stderr.trim().slice(0, 300)}`)
  return JSON.parse(stdout)
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await delay(25)
  if (!predicate()) throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return Promise.race([
    new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code))),
    delay(timeoutMs).then(() => { child.kill('SIGKILL'); throw new Error('Child exit timed out') }),
  ])
}

function shell(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
function firstLine(value, pattern) { return value.split('\n').find((line) => pattern.test(line))?.trim() || null }
