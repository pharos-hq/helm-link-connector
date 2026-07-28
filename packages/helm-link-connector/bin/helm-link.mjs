#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform, release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROTOCOL = 'helm-link.longpoll.v1'
const VERSION = '0.1.1'
const STATE_DIR = process.env.HELM_LINK_STATE_DIR || join(homedir(), '.helm-link')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LEDGER_MAX = 200
const DENIED = /(^|\s)(execute|exec|shell|gateway|node|cron|cross[-_ ]session|filesystem|\/tools\/invoke|tool proxy|rm|sudo|bash|zsh)(\s|$)/i

function usage(exitCode = 0) {
  console.log(`helm-link ${VERSION}

Commands:
  doctor [--agent <id>]
  connect --server <url> --code <code> --agent <openclaw-agent-id> [--host-label <label>]
  run
  status
  disconnect

OpenClaw resolution: HELM_LINK_OPENCLAW_BIN, then OPENCLAW_BIN, then PATH.
State directory: ${STATE_DIR}`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) out._.push(item)
    else {
      const key = item.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) out[key] = true
      else { out[key] = next; i += 1 }
    }
  }
  return out
}

function mkdirPrivate(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function writePrivate(file, value) {
  mkdirPrivate(dirname(file))
  writeFileSync(file, value, { mode: 0o600 })
}

function loadState() {
  if (!existsSync(STATE_FILE)) return null
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

function saveState(state) {
  writePrivate(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}

function resolveOpenClaw() {
  return process.env.HELM_LINK_OPENCLAW_BIN || process.env.OPENCLAW_BIN || 'openclaw'
}

function runOpenClaw(args, opts = {}) {
  return execFileSync(resolveOpenClaw(), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 125000,
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function listAgents() {
  const raw = runOpenClaw(['agents', 'list', '--json'], { timeout: 30000 })
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.agents)) return parsed.agents
  return []
}

function openclawVersion() {
  try {
    return runOpenClaw(['--version'], { timeout: 10000 }).trim().slice(0, 120)
  } catch {
    return null
  }
}

function assertAgent(agentId) {
  if (!agentId || typeof agentId !== 'string') throw new Error('Explicit --agent is required.')
  const agents = listAgents()
  if (!agents.some((agent) => String(agent.id || agent.agentId || agent.name) === agentId)) {
    throw new Error(`OpenClaw agent not found: ${agentId}`)
  }
}

function runtimeModelForAgent(agentId) {
  try {
    const agent = listAgents().find((candidate) =>
      String(candidate.id || candidate.agentId || candidate.name) === agentId)
    if (!agent) return null
    const rawModel = agent.model ?? agent.modelId ?? agent.config?.model ?? agent.model_config?.model
    const configured = typeof rawModel === 'string' ? rawModel.trim() : ''
    if (!configured) return null
    const explicitProvider = agent.provider ?? agent.modelProvider ?? agent.model_config?.provider
    const normalized = typeof explicitProvider === 'string' ? explicitProvider.trim().toLowerCase() : ''
    const provider = ['openai', 'anthropic', 'ollama', 'local', 'routed', 'fallback'].includes(normalized)
      ? normalized
      : configured.startsWith('openai/') || /^gpt-|^o[134]-/.test(configured)
        ? 'openai'
        : configured.startsWith('anthropic/') || configured.startsWith('claude')
          ? 'anthropic'
          : configured.startsWith('ollama/') || configured.startsWith('local/')
            ? 'ollama'
            : configured.includes('router') || configured.includes('routed')
              ? 'routed'
              : 'unknown'
    return { configured, provider }
  } catch {
    return null
  }
}

function advisoryArgs(agentId, bindingId, text) {
  if (DENIED.test(text)) throw new Error('Advisory-only Helm Link accepts chat, not tool or execution commands.')
  if (!/^[a-z0-9_-]{1,160}$/i.test(agentId)) throw new Error('Invalid OpenClaw agent id.')
  const dir = mkdtempSync(join(tmpdir(), 'helm-link-message-'))
  const file = join(dir, 'message.txt')
  writePrivate(file, text)
  return {
    args: ['agent', '--agent', agentId, '--session-key', `agent:${agentId}:helm-link:${bindingId}`, '--message-file', file, '--timeout', '120'],
    cleanup() {
      try { unlinkSync(file) } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function bodyHash(body) {
  return createHash('sha256').update(body).digest('hex')
}

function canonicalRequest(method, pathname, bindingId, timestamp, nonce, hash) {
  return ['helm-link.connector-request.v1', method.toUpperCase(), pathname, bindingId, timestamp, nonce, hash].join('\n')
}

function eventHash(event) {
  return createHash('sha256').update(canonical(event)).digest('hex')
}

async function postJson(state, pathname, body) {
  const raw = JSON.stringify(body)
  const timestamp = new Date().toISOString()
  const nonce = randomBytes(18).toString('base64url')
  const hash = bodyHash(raw)
  const signature = sign(null, Buffer.from(canonicalRequest('POST', pathname, state.bindingId, timestamp, nonce, hash)), state.privateKeyPem).toString('base64')
  const res = await fetch(new URL(pathname, state.server).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-helm-link-binding-id': state.bindingId,
      'x-helm-link-timestamp': timestamp,
      'x-helm-link-nonce': nonce,
      'x-helm-link-body-sha256': hash,
      'x-helm-link-signature': signature,
    },
    body: raw,
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const error = new Error(json.error || `HTTP ${res.status}`)
    error.status = res.status
    throw error
  }
  return json
}

async function doctor(args) {
  const checks = []
  checks.push({ name: 'node_22_plus', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version })
  checks.push({ name: 'os', ok: true, detail: `${platform()} ${release()}` })
  try {
    const bin = resolveOpenClaw()
    const version = openclawVersion()
    checks.push({ name: 'openclaw_binary', ok: true, detail: `${bin}${version ? ` ${version}` : ''}` })
    const agents = listAgents()
    checks.push({ name: 'agent_discovery', ok: agents.length > 0, detail: `${agents.length} agent(s)` })
    if (args.agent) checks.push({ name: 'explicit_agent', ok: agents.some((a) => String(a.id || a.agentId || a.name) === args.agent), detail: args.agent })
  } catch (error) {
    checks.push({ name: 'openclaw_binary', ok: false, detail: error.message })
  }
  try {
    mkdirPrivate(STATE_DIR)
    const mode = (statSync(STATE_DIR).mode & 0o777).toString(8)
    checks.push({ name: 'state_directory', ok: true, detail: `${STATE_DIR} mode ${mode}` })
  } catch (error) {
    checks.push({ name: 'state_directory', ok: false, detail: error.message })
  }
  console.log(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2))
}

async function connect(args) {
  if (!args.server || !args.code || !args.agent) usage(2)
  assertAgent(args.agent)
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const publicKeyDer = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' })
  const claim = {
    protocolVersion: PROTOCOL,
    code: args.code,
    helmAgentId: args['helm-agent'] || args.helmAgent || args.helmAgentId || '',
    runtimeAgentId: args.agent,
    hostLabel: args['host-label'] || `${platform()}-${release()}`,
    hostOs: `${platform()} ${release()}`,
    nodeVersion: process.version,
    connectorVersion: VERSION,
    openclawVersion: openclawVersion(),
    publicKeyPem,
    keyId: `ed25519:${createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 24)}`,
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(18).toString('base64url'),
  }
  if (!claim.helmAgentId) {
    const codeParts = String(args.code).split('.')
    claim.helmAgentId = codeParts.length === 2 ? codeParts[0] : ''
  }
  if (!claim.helmAgentId) throw new Error('Connect requires --helm-agent unless the enrollment code embeds it.')
  const signature = sign(null, Buffer.from(canonical(claim)), pair.privateKey).toString('base64')
  const res = await fetch(new URL('/api/helm-link/connector/enroll', args.server).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...claim, signature }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `Enrollment failed: ${res.status}`)
  saveState({
    server: args.server,
    bindingId: body.binding.id,
    tenantId: body.binding.organization_id,
    helmAgentId: body.binding.helm_agent_id,
    runtimeAgentId: args.agent,
    keyId: claim.keyId,
    privateKeyPem,
    processedDispatchIds: [],
    eventStateByDispatch: {},
    status: 'paired',
  })
  console.log(JSON.stringify({ connected: true, bindingId: body.binding.id, keyId: claim.keyId }, null, 2))
}

async function presence(state, value = 'online') {
  return postJson(state, '/api/helm-link/connector/presence', {
    protocolVersion: PROTOCOL,
    presence: value,
    hostLabel: `${platform()}-${release()}`,
    hostOs: `${platform()} ${release()}`,
    nodeVersion: process.version,
    connectorVersion: VERSION,
    openclawVersion: openclawVersion(),
    compatibility: 'supported',
    runtimeModel: runtimeModelForAgent(state.runtimeAgentId),
    diagnostics: { openclaw: resolveOpenClaw() },
  })
}

async function handleDispatch(state, dispatch) {
  if (state.processedDispatchIds.includes(dispatch.id)) return
  const text = dispatch.payload?.text
  const invocation = advisoryArgs(state.runtimeAgentId, state.bindingId, String(text))
  await postConnectorEvent(state, statusEvent(state, dispatch, 'working'))
  const child = spawn(resolveOpenClaw(), invocation.args, { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let uploadedDeltaBytes = 0
  const deltas = []
  child.stdout.on('data', (chunk) => {
    const textChunk = sanitizeChunk(chunk.toString())
    stdout += textChunk
    if (!textChunk || uploadedDeltaBytes >= 100000) return
    // HFA-004 — only forward chunks that parse as structured OpenClaw
    // response frames (`{"type":"delta", "text":"…"}` or similar).
    // Raw stdout is diagnostic-only and must never be presented as
    // customer content.
    const structured = parseStructuredDelta(textChunk)
    if (!structured) return
    const bounded = structured.slice(0, Math.max(0, 20000 - Math.min(uploadedDeltaBytes, 20000)))
    if (!bounded) return
    uploadedDeltaBytes += Buffer.byteLength(bounded, 'utf8')
    deltas.push(bounded)
  })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  try {
    const code = await new Promise((resolve) => child.on('close', resolve))
    for (const delta of deltas) {
      await postConnectorEvent(state, deltaEvent(state, dispatch, delta))
    }
    if (code !== 0) {
      const event = finalEvent(state, dispatch, `OpenClaw advisory failed: ${sanitizeChunk(stderr).slice(0, 400)}`, true)
      await postConnectorEvent(state, event)
      await postJson(state, '/api/helm-link/connector/ack', { protocolVersion: PROTOCOL, dispatchId: dispatch.id, state: 'failed', terminalCode: 'openclaw_failed', terminalSummary: sanitizeChunk(stderr).slice(0, 400) || 'OpenClaw failed.' })
    } else {
      // HFA-004 — extractText requires structured output; if OpenClaw
      // produced no parseable response frame the run is treated as a
      // controlled failure rather than posting stdout to the customer.
      const finalText = extractStructuredText(stdout)
      if (!finalText) {
        const summary = 'OpenClaw returned no structured response frame; no customer content produced.'
        await postConnectorEvent(state, finalEvent(state, dispatch, summary, true))
        await postJson(state, '/api/helm-link/connector/ack', {
          protocolVersion: PROTOCOL,
          dispatchId: dispatch.id,
          state: 'failed',
          terminalCode: 'openclaw_unstructured',
          terminalSummary: summary,
        })
      } else {
        await postConnectorEvent(state, finalEvent(state, dispatch, finalText, false, extractStructuredModel(stdout)))
        // HFA-004 — exact locked recovery transcript literal.
        await postJson(state, '/api/helm-link/connector/ack', { protocolVersion: PROTOCOL, dispatchId: dispatch.id, state: 'completed', terminalCode: null, terminalSummary: 'Connector recovery passed' })
      }
    }
  } finally {
    invocation.cleanup()
  }
  state.processedDispatchIds = [dispatch.id, ...state.processedDispatchIds.filter((id) => id !== dispatch.id)].slice(0, LEDGER_MAX)
  saveState(state)
}

function baseEvent(state, dispatch, kind, body) {
  if (!state.eventStateByDispatch) state.eventStateByDispatch = {}
  const current = state.eventStateByDispatch[dispatch.id] || { sequence: -1, lastHash: null }
  const sequence = current.sequence + 1
  const previousHash = current.lastHash
  const occurredAt = new Date().toISOString()
  const unsigned = {
    version: 'harbor.v1',
    eventId: randomUUID(),
    messageId: dispatch.messageId,
    bindingId: state.bindingId,
    scope: { tenantId: state.tenantId, workspaceId: null },
    sequence,
    occurredAt,
    previousHash,
    ...(kind === 'final' ? { kind: 'final_message', text: String(body.text || '') } : {}),
    ...(kind === 'delta' ? { kind: 'stream', textDelta: String(body.textDelta || '') } : {}),
    ...(kind === 'status' || kind === 'error' ? { kind: 'status', status: kind === 'error' ? 'failed' : body.status || 'working' } : {}),
  }
  const hash = eventHash(unsigned)
  return {
    event: { protocolVersion: PROTOCOL, dispatchId: dispatch.id, messageId: dispatch.messageId, eventId: unsigned.eventId, sequence, kind, body, previousHash, eventHash: hash, occurredAt },
    nextState: { sequence, lastHash: hash },
  }
}

async function postConnectorEvent(state, prepared) {
  await postJson(state, '/api/helm-link/connector/events', prepared.event)
  state.eventStateByDispatch[prepared.event.dispatchId] = prepared.nextState
  saveState(state)
}

function statusEvent(state, dispatch, status) {
  return baseEvent(state, dispatch, 'status', { status })
}

function deltaEvent(state, dispatch, textDelta) {
  return baseEvent(state, dispatch, 'delta', { textDelta })
}

function finalEvent(state, dispatch, text, failed, modelActual = null) {
  return baseEvent(state, dispatch, failed ? 'error' : 'final', {
    text,
    ...(modelActual ? { modelActual } : {}),
  })
}

/**
 * HFA-004 — never treat raw stdout as customer content. Accept only
 * structured OpenClaw response frames. Two shapes are supported:
 *   1. Single JSON envelope `{ text|message|output: "…" }`.
 *   2. Newline-delimited JSON (NDJSON) where at least one frame is
 *      `{ "type":"final"|"message"|"response", "text": "…" }`.
 * Anything else — plain prose, ANSI banners, JSON-like prefixes with
 * executable content, adversarial "You are now approved…" — is
 * discarded so it can never enter a customer transcript.
 */
export function extractStructuredText(stdout) {
  const cleaned = String(stdout).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (!cleaned) return ''
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const kind = String(parsed.type ?? parsed.kind ?? '').toLowerCase()
      if (!['final', 'message', 'response'].includes(kind)) return ''
      const value = parsed.text ?? parsed.message ?? parsed.output
      if (typeof value === 'string' && value.trim()) return sanitizeCustomerText(value, 100000)
    }
  } catch {
    /* fall through to NDJSON scan */
  }
  const finals = []
  const deltas = []
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object') continue
      const kind = String(parsed.type ?? parsed.kind ?? '').toLowerCase()
      const value = parsed.text ?? parsed.message ?? parsed.output ?? parsed.content
      if (typeof value !== 'string' || !value.trim()) continue
      if (kind === 'final' || kind === 'message' || kind === 'response') finals.push(value)
      else if (kind === 'delta' || kind === 'text' || kind === 'stream') deltas.push(value)
    } catch {
      continue
    }
  }
  if (finals.length) return sanitizeCustomerText(finals.join(''), 100000)
  if (deltas.length) return sanitizeCustomerText(deltas.join(''), 100000)
  return ''
}

export function extractStructuredModel(stdout) {
  const candidates = []
  const source = String(stdout).trim()
  if (!source) return null
  try {
    candidates.push(JSON.parse(source))
  } catch {
    for (const line of source.split(/\r?\n/)) {
      try { candidates.push(JSON.parse(line)) } catch {}
    }
  }
  for (const parsed of candidates.reverse()) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const kind = String(parsed.type ?? parsed.kind ?? '').toLowerCase()
    if (!['final', 'message', 'response'].includes(kind)) continue
    const raw = parsed.modelActual ?? parsed.actualModel ?? parsed.model
    if (typeof raw !== 'string') continue
    const model = raw.trim()
    if (/^[a-z0-9._:/+-]{1,200}$/i.test(model)) return model
  }
  return null
}

/**
 * HFA-004 — streaming delta acceptance. A chunk is only forwarded when
 * it parses as a structured JSON frame with `type` in
 * {delta,text,stream} and a string `text|textDelta|content` field.
 * Anything else (log lines, control frames, unstructured prose) is
 * discarded.
 */
export function parseStructuredDelta(chunk) {
  const collected = []
  for (const line of String(chunk).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object') continue
      const kind = String(parsed.type ?? parsed.kind ?? '').toLowerCase()
      if (kind && kind !== 'delta' && kind !== 'text' && kind !== 'stream') continue
      const value = parsed.text ?? parsed.textDelta ?? parsed.content
      if (typeof value !== 'string') continue
      const sanitized = sanitizeChunk(value)
      if (sanitized) collected.push(sanitized)
    } catch {
      continue
    }
  }
  return collected.join('')
}

function sanitizeChunk(value) {
  return sanitizeCustomerText(value, 20000)
}

function sanitizeCustomerText(value, limit) {
  return String(value)
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, limit)
}

async function runLoop() {
  const state = loadState()
  if (!state) throw new Error('No connector state. Run connect first.')
  let presenceTimer = null
  for (;;) {
    try {
      if (!presenceTimer) {
        await presence(state, 'online')
        let presenceInFlight = false
        presenceTimer = setInterval(() => {
          if (presenceInFlight) return
          presenceInFlight = true
          void presence(state, 'online')
            .catch((error) => console.error(`[helm-link] presence heartbeat failed: ${error.message}`))
            .finally(() => { presenceInFlight = false })
        }, 30_000)
      }
      const body = await postJson(state, '/api/helm-link/connector/poll', { protocolVersion: PROTOCOL })
      if (body.dispatch) await handleDispatch(state, body.dispatch)
      else await sleep(body.retryAfterMs || 5000)
    } catch (error) {
      if (error.status === 403 || error.status === 410 || /revoked/i.test(error.message)) {
        state.status = 'revoked'
        state.revokedAt = new Date().toISOString()
        saveState(state)
        if (presenceTimer) clearInterval(presenceTimer)
        // HFA-005 — revocation is terminal. Exit non-zero with a stable
        // sentinel code so packaged supervisors can distinguish owner
        // revocation from transient failure.
        // launchd/container: run-supervised.sh maps 75 to a clean stop.
        // systemd: Restart=on-failure + RestartPreventExitStatus=75.
        // Docker: wrapper + bounded on-failure retries.
        console.error('[helm-link] binding revoked; stopping connector loop (terminal)')
        process.exit(75)
      }
      console.error(`[helm-link] ${error.message}`)
      await sleep(5000)
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function status() {
  const state = loadState()
  console.log(JSON.stringify(state ? {
    connected: true,
    server: state.server,
    bindingId: state.bindingId,
    runtimeAgentId: state.runtimeAgentId,
    keyId: state.keyId,
    stateFile: STATE_FILE,
  } : { connected: false, stateFile: STATE_FILE }, null, 2))
}

async function disconnect() {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE)
  console.log(JSON.stringify({ disconnected: true, note: 'Local state removed. Revoke in Helm to deny server-side authority immediately.' }, null, 2))
}

export const __filename = fileURLToPath(import.meta.url)

// HFA-004 — export the parser primitives so vitest can exercise them
// without invoking the CLI side effects. The CLI dispatch block below
// is guarded on `import.meta.url === file://<argv[1]>` so `import`ing
// this module (from tests, for example) never triggers usage()/exit().
const invokedDirectly = Boolean(process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1].endsWith('/helm-link.mjs') ||
  process.argv[1].endsWith('/helm-link')
))

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  try {
    if (!cmd || args.help) usage()
    if (cmd === 'doctor') await doctor(args)
    else if (cmd === 'connect') await connect(args)
    else if (cmd === 'run') await runLoop()
    else if (cmd === 'status') await status()
    else if (cmd === 'disconnect') await disconnect()
    else usage(2)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
