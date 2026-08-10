#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform, release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createLifecycleJournal } from '../lib/lifecycle-journal.mjs'
import { claimInvocation, listInvocationClaims, markInvocationStarted } from '../lib/invocation-claims.mjs'
import {
  markTerminalDelivered,
  migrateProcessedLedger,
  pendingTerminalOutbox,
  readTerminalRecord,
  recordTerminal,
  recoverAmbiguousInvocations,
  writeTerminalOutbox,
} from '../lib/terminal-store.mjs'
import { classifyWorkloadText, validateRunContract } from '../lib/workload-contract.mjs'

const PROTOCOL = 'helm-link.longpoll.v1'
const VERSION = '0.2.7'
const STATE_DIR = process.env.HELM_LINK_STATE_DIR || join(homedir(), '.helm-link')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LIFECYCLE_FILE = join(STATE_DIR, 'lifecycle.ndjson')
const SERVICE_LABEL = 'com.pharos.helm-link'
const LEDGER_MAX = 200
const HTTP_REQUEST_TIMEOUT_MS = 20_000
const DATA_PLANE_STALE_MS = 90_000
const DENIED = /(^|\s)(execute|exec|shell|gateway|node|cron|cross[-_ ]session|filesystem|\/tools\/invoke|tool proxy|rm|sudo|bash|zsh)(\s|$)/i

function usage(exitCode = 0) {
  console.log(`helm-link ${VERSION}

Commands:
  doctor [--agent <id>]
  connect --server <url> --code <code> --agent <openclaw-agent-id> [--host-label <label>] [--install-service]
  install-service
  uninstall-service
  service-status
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

export function advisoryArgs(agentId, bindingId, text, { noToolsAttested = false } = {}) {
  // Lane selection is an explicit Helm dispatch contract, never a prompt
  // classifier. Ordinary connected OpenClaw agents keep their existing host
  // policy; Helm transports chat but grants no additional tool authority.
  // The legacy no-tools advisory restrictions remain only for runtimes that
  // truthfully opted into that stricter host-attested mode.
  if (noToolsAttested && DENIED.test(text)) throw new Error('Advisory-only Helm Link accepts chat, not tool or execution commands.')
  if (noToolsAttested && classifyWorkloadText(text).lane !== 'chat') throw new Error('Operational work requires a durable Helm Link Run.')
  if (!/^[a-z0-9_-]{1,160}$/i.test(agentId)) throw new Error('Invalid OpenClaw agent id.')
  const dir = mkdtempSync(join(tmpdir(), 'helm-link-message-'))
  const file = join(dir, 'message.txt')
  writePrivate(file, text)
  return {
    args: ['agent', '--agent', agentId, '--session-key', `agent:${agentId}:helm-link:${bindingId}`, '--message-file', file, '--timeout', '120', '--json'],
    cleanup() {
      try { unlinkSync(file) } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

export function operationalArgs(agentId, bindingId, dispatchId, text, contract, expiresAt) {
  const run = validateRunContract(contract)
  if (!/^[a-z0-9_-]{1,160}$/i.test(agentId)) throw new Error('Invalid OpenClaw agent id.')
  const parsedExpiry = Date.parse(expiresAt)
  if (!Number.isFinite(parsedExpiry)) throw new Error('Durable Run queue deadline is invalid.')
  const queueRemainingMs = parsedExpiry - Date.now()
  if (queueRemainingMs <= 0) throw new Error('Durable Run queue deadline elapsed before OpenClaw invocation.')
  const dir = mkdtempSync(join(tmpdir(), 'helm-link-run-'))
  const file = join(dir, 'message.txt')
  writePrivate(file, text)
  const executionTimeoutSeconds = Math.max(1, Math.floor(run.deadlineMs / 1000))
  return {
    args: ['agent', '--agent', agentId, '--session-key', `agent:${agentId}:helm-run:${bindingId}:${dispatchId}`,
      '--message-file', file, '--timeout', String(executionTimeoutSeconds), '--json'],
    // OpenClaw 2026.7.1 does not expose Helm's run-id or queue/deadline
    // options. Run identity remains fenced by the dispatch-scoped session key
    // and local invocation claim. The supported CLI timeout plus this parent
    // timer enforce the execution deadline independently of the child.
    timeoutMs: run.deadlineMs + 5_000,
    queueDeadlineAt: parsedExpiry,
    executionTimeoutMs: run.deadlineMs,
    cleanup() {
      try { unlinkSync(file) } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

const REQUIRED_OPENCLAW_AGENT_OPTIONS = ['--agent', '--message-file', '--session-key', '--timeout', '--json']

export function inspectOpenClawAgentHelp(helpText) {
  const help = String(helpText || '')
  const missing = REQUIRED_OPENCLAW_AGENT_OPTIONS.filter((option) => !help.includes(option))
  return { compatible: missing.length === 0, missing, required: [...REQUIRED_OPENCLAW_AGENT_OPTIONS] }
}

export async function preflightOpenClawAgentCompatibility({ runImpl = runOpenClawAdvisory } = {}) {
  const result = await runImpl({
    args: ['agent', '--help'],
    timeoutMs: 10_000,
    outputLimit: 100_000,
    stderrLimit: 25_000,
  })
  if (result.terminationCause !== 'completed') {
    const detail = sanitizeRuntimeError(result.stderr)
    throw new Error(`OpenClaw agent compatibility preflight failed${detail ? `: ${detail}` : ` (${result.terminationCause || 'unknown failure'})`}.`)
  }
  const report = inspectOpenClawAgentHelp(result.stdout)
  if (!report.compatible) {
    throw new Error(`OpenClaw agent compatibility preflight failed: missing required options ${report.missing.join(', ')}. Upgrade OpenClaw or install a connector version compatible with this runtime.`)
  }
  return report
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

export async function postJson(state, pathname, body, { timeoutMs = HTTP_REQUEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const raw = JSON.stringify(body)
  const timestamp = new Date().toISOString()
  const nonce = randomBytes(18).toString('base64url')
  const hash = bodyHash(raw)
  const signature = sign(null, Buffer.from(canonicalRequest('POST', pathname, state.bindingId, timestamp, nonce, hash)), state.privateKeyPem).toString('base64')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  let text
  try {
    res = await fetchImpl(new URL(pathname, state.server).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-helm-link-binding-id': state.bindingId,
        'x-helm-link-timestamp': timestamp,
        'x-helm-link-nonce': nonce,
        'x-helm-link-body-sha256': hash,
        'x-helm-link-signature': signature,
        ...(Number.isSafeInteger(state.fencingToken)
          ? { 'x-helm-link-fencing-token': String(state.fencingToken) }
          : {}),
      },
      body: raw,
      signal: controller.signal,
    })
    // Keep the same deadline active through body consumption. fetch()
    // resolves at headers; a stalled body must not wedge the poll loop.
    text = await res.text()
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Connector request timed out after ${timeoutMs}ms: ${pathname}`)
      timeoutError.code = 'helm_link_request_timeout'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const error = new Error(json.error || `HTTP ${res.status}`)
    error.status = res.status
    throw error
  }
  return json
}

// Cancellation is durable control traffic. Keep the call site distinct from
// ordinary acquisition/presence/event traffic so the server can reserve an
// independently governed budget for it. The server derives the traffic class
// from the authenticated route; callers cannot promote arbitrary requests.
export async function postControlJson(state, pathname, body, options = {}) {
  return postJson(state, pathname, body, options)
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
    advisoryNoToolsAttested: args['advisory-no-tools-attested'] === true,
  })
  let service = null
  if (args['install-service']) service = installService()
  console.log(JSON.stringify({ connected: true, bindingId: body.binding.id, keyId: claim.keyId, service }, null, 2))
}

export function buildLaunchdPlist({ wrapper, node, connector, stateDir, openclaw, servicePath, stdout, stderr }) {
  const xml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(wrapper)}</string>
    <string>${xml(node)}</string>
    <string>${xml(connector)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HELM_LINK_STATE_DIR</key><string>${xml(stateDir)}</string>
    <key>HELM_LINK_OPENCLAW_BIN</key><string>${xml(openclaw)}</string>
    <key>PATH</key><string>${xml(servicePath)}</string>
    <key>NO_COLOR</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`
}

function resolveOpenClawAbsolute() {
  const configured = resolveOpenClaw()
  if (configured.startsWith('/')) return configured
  return execFileSync('/usr/bin/which', [configured], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function servicePaths() {
  const runtimeDir = join(STATE_DIR, 'runtime', VERSION)
  const logDir = join(STATE_DIR, 'logs')
  return {
    runtimeDir,
    logDir,
    connector: join(runtimeDir, 'bin', 'helm-link.mjs'),
    wrapper: join(runtimeDir, 'run-supervised.sh'),
    plist: join(process.env.HELM_LINK_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents'), `${SERVICE_LABEL}.plist`),
    stdout: join(logDir, 'connector.out.log'),
    stderr: join(logDir, 'connector.err.log'),
  }
}

function packageRoot() {
  return join(dirname(__filename), '..')
}

function copyRuntimeClosure(runtimeDir) {
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirPrivate(runtimeDir)
  for (const relativePath of ['bin', 'lib', 'supervisors', 'package.json']) {
    cpSync(join(packageRoot(), relativePath), join(runtimeDir, relativePath), {
      recursive: true,
      force: true,
      errorOnExist: false,
    })
  }
  chmodSync(join(runtimeDir, 'bin', 'helm-link.mjs'), 0o700)
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const binary = process.env.HELM_LINK_LAUNCHCTL_BIN || '/bin/launchctl'
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launchctl ${args[0]} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  }
  return result
}

export function installService({ platformName = platform() } = {}) {
  if (platformName !== 'darwin') {
    throw new Error('install-service currently supports macOS launchd only; use the packaged systemd/container supervisor on other hosts.')
  }
  const state = loadState()
  if (!state) throw new Error('No connector state. Run connect first.')
  if (state.status === 'revoked') throw new Error('Revoked connector state cannot be supervised. Reconnect with a fresh enrollment.')

  const paths = servicePaths()
  copyRuntimeClosure(paths.runtimeDir)
  mkdirPrivate(paths.logDir)
  mkdirSync(dirname(paths.plist), { recursive: true, mode: 0o700 })

  const packagedWrapper = join(paths.runtimeDir, 'supervisors', 'run-supervised.sh')
  writeFileSync(paths.wrapper, readFileSync(packagedWrapper), { mode: 0o700 })
  chmodSync(paths.wrapper, 0o700)

  const openclaw = resolveOpenClawAbsolute()
  // launchd's default PATH omits Homebrew. The OpenClaw entry point uses
  // `#!/usr/bin/env node`, so both the exact Node and OpenClaw directories
  // must be present or supervised dispatches fail with exit 127.
  const servicePath = [...new Set([
    dirname(process.execPath),
    dirname(openclaw),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])].join(':')
  const plist = buildLaunchdPlist({
    wrapper: paths.wrapper,
    node: process.execPath,
    connector: paths.connector,
    stateDir: STATE_DIR,
    openclaw,
    servicePath,
    stdout: paths.stdout,
    stderr: paths.stderr,
  })
  writeFileSync(paths.plist, plist, { mode: 0o600 })

  const domain = `gui/${process.getuid()}`
  const target = `${domain}/${SERVICE_LABEL}`
  runLaunchctl(['bootout', target], { allowFailure: true })
  runLaunchctl(['enable', target])
  runLaunchctl(['bootstrap', domain, paths.plist])
  runLaunchctl(['kickstart', '-k', target])

  return { installed: true, label: SERVICE_LABEL, plist: paths.plist, version: VERSION }
}

export function uninstallService({ platformName = platform() } = {}) {
  if (platformName !== 'darwin') {
    throw new Error('uninstall-service currently supports macOS launchd only; remove the packaged systemd/container supervisor on that host.')
  }
  const paths = servicePaths()
  const target = `gui/${process.getuid()}/${SERVICE_LABEL}`
  runLaunchctl(['bootout', target], { allowFailure: true })
  if (existsSync(paths.plist)) rmSync(paths.plist)
  if (existsSync(paths.runtimeDir)) rmSync(paths.runtimeDir, { recursive: true, force: true })
  return { uninstalled: true, label: SERVICE_LABEL, plist: paths.plist, version: VERSION }
}

function launchdProcessFromOutput(output) {
  const pid = Number(output.match(/(?:^|\n)\s*pid\s*=\s*(\d+)/)?.[1] || 0)
  const state = output.match(/(?:^|\n)\s*state\s*=\s*([^\n]+)/)?.[1]?.trim() || null
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    launchdState: state,
  }
}

function launchdServiceDisabledFromOutput(output, label = SERVICE_LABEL) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`["']?${escapedLabel}["']?\\s*(?:=>|=)\\s*(true|false|enabled|disabled)\\b`))
  return match ? ['true', 'disabled'].includes(match[1]) : null
}

function pidIsRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function latestHeartbeatFresh(state, nowMs = Date.now()) {
  const raw = state?.lastSuccessfulHeartbeatAt
  if (!raw) return false
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && nowMs - parsed < DATA_PLANE_STALE_MS * 3
}

function runtimeClosureComplete(paths = servicePaths()) {
  return existsSync(paths.connector) && existsSync(join(paths.runtimeDir, 'lib', 'lifecycle-journal.mjs'))
}

export function connectorStatus({ platformName = platform(), nowMs = Date.now() } = {}) {
  const state = loadState()
  if (!state) {
    return {
      label: SERVICE_LABEL,
      installed: false,
      connected: false,
      locallyPaired: false,
      serviceEnabled: false,
      processRunning: false,
      serverReachable: false,
      heartbeatAccepted: false,
      runtimeComplete: false,
      stateFile: STATE_FILE,
      version: VERSION,
      connectorVersion: VERSION,
      boundRuntimeAgentId: null,
      boundHelmAgentId: null,
      lastSuccessfulHeartbeatAt: null,
      actionableFailureReason: 'No local connector state. Generate a fresh enrollment in Helm and run the connect command.',
    }
  }
  if (platformName !== 'darwin') {
    return {
      label: SERVICE_LABEL,
      installed: false,
      connected: false,
      locallyPaired: state.status === 'paired',
      serviceEnabled: false,
      processRunning: false,
      serverReachable: false,
      heartbeatAccepted: false,
      runtimeComplete: false,
      status: state.status || 'unknown',
      stateFile: STATE_FILE,
      version: VERSION,
      connectorVersion: VERSION,
      boundRuntimeAgentId: state.runtimeAgentId || null,
      boundHelmAgentId: state.helmAgentId || null,
      bindingId: state.bindingId || null,
      lastSuccessfulHeartbeatAt: state.lastSuccessfulHeartbeatAt || null,
      actionableFailureReason: 'service-status currently supports macOS launchd only on this host.',
    }
  }
  const target = `gui/${process.getuid()}/${SERVICE_LABEL}`
  const result = runLaunchctl(['print', target], { allowFailure: true })
  const disabledResult = runLaunchctl(['print-disabled', `gui/${process.getuid()}`], { allowFailure: true })
  const launchd = launchdProcessFromOutput(result.stdout || '')
  const processRunning = pidIsRunning(launchd.pid)
  const heartbeatAccepted = latestHeartbeatFresh(state, nowMs)
  const paths = servicePaths()
  const runtimePresent = existsSync(paths.runtimeDir)
  const installed = existsSync(paths.plist) && runtimePresent
  const disabled = disabledResult.status === 0
    ? launchdServiceDisabledFromOutput(disabledResult.stdout || '', SERVICE_LABEL)
    : null
  const serviceEnabled = Boolean(installed && disabled === false)
  const runtimeComplete = runtimeClosureComplete()
  const locallyPaired = state.status === 'paired'
  const connected = Boolean(installed && serviceEnabled && runtimeComplete && processRunning && locallyPaired && heartbeatAccepted)
  let actionableFailureReason = null
  if (state.status === 'revoked') actionableFailureReason = 'Server authority was revoked. Reconnect in Helm with a fresh enrollment.'
  else if (!installed) actionableFailureReason = 'LaunchAgent is not installed. Run helm-link install-service after pairing.'
  else if (!serviceEnabled) actionableFailureReason = disabled === true
    ? 'LaunchAgent is installed but disabled. Run helm-link install-service to enable and restart it.'
    : 'LaunchAgent enabled state could not be verified. Run helm-link install-service to refresh the supervised runtime.'
  else if (!runtimeComplete) actionableFailureReason = 'LaunchAgent runtime is incomplete. Run helm-link install-service to reinstall the packaged connector runtime.'
  else if (state.openclawCompatibilityFailure?.summary) actionableFailureReason = state.openclawCompatibilityFailure.summary
  else if (!processRunning) actionableFailureReason = 'LaunchAgent is installed but the connector process is not running. Run helm-link install-service to refresh the supervised runtime.'
  else if (!locallyPaired) actionableFailureReason = 'Local connector state is not paired. Reconnect in Helm with a fresh enrollment.'
  else if (!heartbeatAccepted) actionableFailureReason = 'No recent server-accepted heartbeat. Wait for the connector to reach Helm or reconnect if the server binding is stale.'
  return {
    label: SERVICE_LABEL,
    installed,
    connected,
    locallyPaired,
    serviceEnabled,
    processRunning,
    pid: launchd.pid,
    launchdState: launchd.launchdState,
    launchdDisabled: disabled,
    serverReachable: heartbeatAccepted,
    heartbeatAccepted,
    runtimeComplete,
    status: state.status || 'unknown',
    stateFile: STATE_FILE,
    version: VERSION,
    connectorVersion: VERSION,
    boundRuntimeAgentId: state.runtimeAgentId || null,
    boundHelmAgentId: state.helmAgentId || null,
    bindingId: state.bindingId || null,
    lastSuccessfulHeartbeatAt: state.lastSuccessfulHeartbeatAt || null,
    actionableFailureReason,
  }
}

function serviceStatus() {
  const result = connectorStatus()
  console.log(JSON.stringify(result, null, 2))
  if (!result.connected) process.exitCode = 1
}

export function deriveLivenessPresence(liveness, nowMs = Date.now()) {
  // Existing Helm schemas admit degraded but not the transitional
  // connecting value. Fail closed until the first successful poll.
  if (!liveness.lastPollCompletedAt) return 'degraded'
  const latestProgress = Math.max(
    liveness.lastPollCompletedAt || 0,
    liveness.lastDispatchProgressAt || 0,
  )
  const pollHung = liveness.pollStartedAt && nowMs - liveness.pollStartedAt >= HTTP_REQUEST_TIMEOUT_MS
  const dataPlaneStale = nowMs - latestProgress >= DATA_PLANE_STALE_MS
  return pollHung || dataPlaneStale ? 'degraded' : 'online'
}

export function deriveTwoAxisState(liveness, nowMs = Date.now()) {
  const latestProgress = Math.max(liveness.lastPollCompletedAt || 0, liveness.lastDispatchProgressAt || 0)
  const age = latestProgress ? nowMs - latestProgress : Number.POSITIVE_INFINITY
  const connectionHealth = age < DATA_PLANE_STALE_MS
    ? 'available'
    : age < DATA_PLANE_STALE_MS * 3 ? 'degraded' : 'offline'
  const workloadState = liveness.activeDispatchId
    ? 'busy'
    : Number(liveness.queueDepth || 0) > 0 ? 'queued' : 'idle'
  return { connectionHealth, workloadState }
}

async function presence(state, liveness, value = deriveLivenessPresence(liveness), telemetry = {}) {
  const axes = deriveTwoAxisState(liveness)
  return postJson(state, '/api/helm-link/connector/presence', {
    protocolVersion: PROTOCOL,
    presence: value,
    hostLabel: `${platform()}-${release()}`,
    hostOs: `${platform()} ${release()}`,
    nodeVersion: process.version,
    connectorVersion: VERSION,
    openclawVersion: telemetry.openclawVersion ?? null,
    compatibility: 'supported',
    connectionHealth: axes.connectionHealth,
    workloadState: axes.workloadState,
    queueDepth: Number(liveness.queueDepth || 0),
    // Blocker 1: fence authorization must be signed. Present the current
    // ownership epoch inside the signed body; the server never authorizes
    // from the unsigned `x-helm-link-fencing-token` header.
    deliveryFencingToken: Number(state.fencingToken || 0),
    functional: {
      lastPollCompletedAt: liveness.lastPollCompletedAt ? new Date(liveness.lastPollCompletedAt).toISOString() : null,
      lastDispatchProgressAt: liveness.lastDispatchProgressAt ? new Date(liveness.lastDispatchProgressAt).toISOString() : null,
    },
    runtimeModel: telemetry.runtimeModel ?? null,
    diagnostics: {
      openclaw: resolveOpenClaw(),
      dataPlane: value === 'online' ? 'healthy' : value,
      lastPollCompletedAt: liveness.lastPollCompletedAt ? new Date(liveness.lastPollCompletedAt).toISOString() : null,
      lastDispatchProgressAt: liveness.lastDispatchProgressAt ? new Date(liveness.lastDispatchProgressAt).toISOString() : null,
      activeDispatchId: liveness.activeDispatchId,
      activeDispatchStartedAt: liveness.activeDispatchStartedAt ? new Date(liveness.activeDispatchStartedAt).toISOString() : null,
      requestTimeoutMs: HTTP_REQUEST_TIMEOUT_MS,
    },
  })
}

async function acknowledgeTerminal(state, dispatch, acknowledgement, liveness) {
  const durableAck = {
    ...acknowledgement,
    invocationId: acknowledgement.invocationId || state.activeInvocationId || null,
    invocationFencingToken: Number(state.fencingToken || 0),
    deliveryFencingToken: Number(state.fencingToken || 0),
  }
  // Blocker 3, step 1: durably record terminal-delivery *intent* before any
  // absorbing local terminal exists. If the server arbitrates cancellation
  // over our completion, the canonical result the server returns will land
  // in the local absorbing store — never a conflicting locally-authored one.
  writeTerminalOutbox(STATE_DIR, durableAck)
  // Blocker 2/3, step 2: post the ack. The server locks the run+dispatch and
  // returns the canonical absorbing terminal (which may differ from what we
  // requested if cancellation was already durable).
  const canonical = await postCommitTerminal(state, durableAck)
  // Step 3: durably record the canonical terminal locally.
  recordTerminal(STATE_DIR, {
    dispatchId: dispatch.id,
    bindingId: state.bindingId,
    invocationId: durableAck.invocationId,
    invocationFencingToken: durableAck.invocationFencingToken,
    state: canonical.state,
    terminalCode: canonical.terminalCode,
    terminalSummary: canonical.terminalSummary,
    terminalId: canonical.terminalId,
  })
  if (canonical.terminalId) {
    // Step 4/5: signed, fenced, idempotent receipt marks the server outbox
    // row `delivered` and returns the delivered_at.
    await postTerminalReceipt(state, {
      dispatchId: dispatch.id,
      terminalId: canonical.terminalId,
    })
  }
  // Step 6: local delivery marker so restart-safe scanning skips it.
  markTerminalDelivered(STATE_DIR, dispatch.id)
  liveness.lastDispatchProgressAt = Date.now()
  saveState(state)
}

export async function postCommitTerminal(state, durableAck, { postImpl = postJson } = {}) {
  const response = await postImpl(state, '/api/helm-link/connector/ack', durableAck)
  if (response?.ok === false) {
    throw new Error('Terminal acknowledgement was not accepted by the server')
  }
  const canonical = response?.canonical ?? {}
  if (typeof response?.terminalId !== 'string' || !response.terminalId) {
    throw new Error('Terminal acknowledgement did not return a canonical terminal identity')
  }
  return {
    ok: true,
    duplicate: response?.duplicate === true,
    arbitrated: response?.arbitrated === true,
    terminalId: response?.terminalId ?? null,
    state: canonical.state ?? durableAck.state,
    terminalCode: canonical.terminalCode ?? durableAck.terminalCode,
    terminalSummary: canonical.terminalSummary ?? durableAck.terminalSummary,
  }
}

export async function postTerminalReceipt(state, { dispatchId, terminalId }, { postImpl = postJson } = {}) {
  return postImpl(state, '/api/helm-link/connector/receipts', {
    protocolVersion: PROTOCOL,
    dispatchId,
    terminalId,
    deliveryFencingToken: Number(state.fencingToken || 0),
  })
}

export async function flushPendingAcks(state, liveness, {
  root = STATE_DIR,
  postImpl = postJson,
} = {}) {
  for (const acknowledgement of pendingTerminalOutbox(root)) {
    const deliverable = prepareTerminalDelivery(state, acknowledgement)
    if (acknowledgement.recovery) {
      const recoveryResponse = await postImpl(state, '/api/helm-link/connector/recoveries', deliverable)
      // The recovery RPC creates the outbox row on the server; the same
      // explicit receipt closes it out so no relevant outbox row lingers.
      if (recoveryResponse?.ok === false
          || typeof recoveryResponse?.terminalId !== 'string'
          || !recoveryResponse.terminalId) {
        throw new Error('Ambiguous-outcome recovery did not return a canonical terminal identity')
      }
      await postTerminalReceipt(state, {
        dispatchId: acknowledgement.dispatchId,
        terminalId: recoveryResponse.terminalId,
      }, { postImpl })
      markTerminalDelivered(root, acknowledgement.dispatchId)
    } else {
      const canonical = await postCommitTerminal(state, deliverable, { postImpl })
      recordTerminal(root, {
        dispatchId: acknowledgement.dispatchId,
        bindingId: state.bindingId,
        invocationId: deliverable.invocationId ?? null,
        invocationFencingToken: Number(deliverable.invocationFencingToken || 0),
        state: canonical.state,
        terminalCode: canonical.terminalCode,
        terminalSummary: canonical.terminalSummary,
        terminalId: canonical.terminalId,
      })
      if (canonical.terminalId) {
        await postTerminalReceipt(state, {
          dispatchId: acknowledgement.dispatchId,
          terminalId: canonical.terminalId,
        }, { postImpl })
      }
      markTerminalDelivered(root, acknowledgement.dispatchId)
    }
    liveness.lastDispatchProgressAt = Date.now()
  }
  for (const [dispatchId, acknowledgement] of Object.entries(state.pendingAcks || {})) {
    await postImpl(state, '/api/helm-link/connector/ack', acknowledgement)
    delete state.pendingAcks[dispatchId]
    state.processedDispatchIds = [dispatchId, ...state.processedDispatchIds.filter((id) => id !== dispatchId)].slice(0, LEDGER_MAX)
    liveness.lastDispatchProgressAt = Date.now()
    saveState(state)
  }
}

export async function convergeStartupTerminals(state, claims, liveness, options = {}) {
  const root = options.root ?? STATE_DIR
  // A durable acknowledgement intent is stronger evidence than a bare claim:
  // it proves execution reached the terminal-delivery boundary. Replay that
  // idempotent acknowledgement first so a lost HTTP response converges on the
  // server's canonical terminal instead of being overwritten as an ambiguous
  // recovery.
  await flushPendingAcks(state, liveness, { ...options, root })

  // Only claims that still have neither a local terminal nor a pending
  // acknowledgement are genuinely ambiguous. They become absorbing
  // no-replay recovery terminals, then their recovery outbox is flushed.
  recoverAmbiguousInvocations(root, state, claims)
  await flushPendingAcks(state, liveness, { ...options, root })
}

export function prepareTerminalDelivery(state, acknowledgement) {
  return {
    ...acknowledgement,
    deliveryFencingToken: Number(state.fencingToken || 0),
  }
}

export function classifyCancellationTerminal(cancellation) {
  const providerStarted = cancellation?.providerStarted === true
  const confirmed = cancellation?.resolved === true && cancellation?.cancelled === true
  const terminalCode = confirmed
    ? providerStarted ? 'cancelled_during_execution' : 'cancelled_before_provider'
    : 'execution_outcome_unknown'
  const terminalSummary = confirmed
    ? providerStarted
      ? 'Run cancellation was confirmed after provider execution began.'
      : 'Run cancellation was confirmed before provider execution began.'
    : 'Cancellation raced a Gateway interruption; execution outcome is unknown and replay is forbidden.'
  return { terminalCode, terminalSummary }
}

export async function settleCancellationAuthority(cancellation, {
  timeoutMs = 7_500,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (cancellation?.requested !== true || cancellation.resolved === true) return cancellation
  const deadline = Date.now() + timeoutMs
  while (cancellation.resolved !== true && Date.now() < deadline) await sleepImpl(10)
  return cancellation
}

function gatewayEnvelopeOutcome(stdout) {
  try {
    const value = JSON.parse(stdout)
    return {
      status: typeof value?.status === 'string' ? value.status : null,
      summary: typeof value?.summary === 'string' ? value.summary.slice(0, 80) : null,
      stopReason: typeof value?.stopReason === 'string' ? value.stopReason : null,
      aborted: value?.result?.aborted === true || value?.result?.meta?.aborted === true,
    }
  } catch {
    return { status: null, summary: null, stopReason: null, aborted: false }
  }
}

export function sanitizeRuntimeError(value, limit = 400) {
  return sanitizeCustomerText(value, limit * 3)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gh[pousr]_|sk_(?:live|test)_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PAT))=([^\s]+)/g, '$1=[redacted]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1[redacted]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, limit)
}

export async function handleDispatch(state, dispatch, liveness, options = {}) {
  const root = options.root ?? STATE_DIR
  const registerClaimImpl = options.registerClaimImpl ?? registerInvocationClaim
  const postEventImpl = options.postEventImpl ?? postConnectorEvent
  const acknowledgeImpl = options.acknowledgeImpl ?? acknowledgeTerminal
  const runImpl = options.runImpl ?? runOpenClawAdvisory
  const operationalArgsImpl = options.operationalArgsImpl ?? operationalArgs
  const advisoryArgsImpl = options.advisoryArgsImpl ?? advisoryArgs
  if (readTerminalRecord(root, dispatch.id)) return
  if (state.pendingAcks?.[dispatch.id]) {
    await flushPendingAcks(state, liveness, { root })
    return
  }
  const journal = createLifecycleJournal(options.lifecycleFile ?? LIFECYCLE_FILE)
  const invocationId = randomUUID()
  const claim = claimInvocation(root, {
    dispatchId: dispatch.id,
    bindingId: state.bindingId,
    fencingToken: Number(state.fencingToken || 0),
    invocationId,
  })
  journal('invocation_claimed', claim)
  const text = String(dispatch.payload?.text || '')
  const lane = dispatch.payload?.kind === 'run' ? 'run' : 'chat'
  let invocation = null
  let phase = 'claim-registration'
  state.activeInvocationId = invocationId
  liveness.activeDispatchId = dispatch.id
  liveness.activeGatewayRunId = dispatch.id
  liveness.cancellation = null
  liveness.activeDispatchStartedAt = Date.now()
  try {
    await registerClaimImpl(state, claim)
    journal('invocation_claim_registered', {
      dispatchId: dispatch.id,
      bindingId: state.bindingId,
      invocationId,
      fencingToken: claim.fencingToken,
    })
    phase = 'admission'
    invocation = lane === 'run'
      ? operationalArgsImpl(state.runtimeAgentId, state.bindingId, dispatch.id, text, dispatch.payload?.contract, dispatch.expiresAt)
      : advisoryArgsImpl(state.runtimeAgentId, state.bindingId, text, { noToolsAttested: state.advisoryNoToolsAttested === true })
    phase = 'execution'
    journal('dispatch_received', { dispatchId: dispatch.id, bindingId: state.bindingId })
    await postEventImpl(state, statusEvent(state, dispatch, 'working'))
    liveness.lastDispatchProgressAt = Date.now()
    const result = await runImpl({
      args: invocation.args,
      timeoutMs: invocation.timeoutMs,
      lifecycle: (kind, fields) => journal(kind, {
        dispatchId: dispatch.id,
        bindingId: state.bindingId,
        ...fields,
      }),
      onSpawn: ({ pid, startedAt }) => markInvocationStarted(root, dispatch.id, {
        invocationId,
        bindingId: state.bindingId,
        fencingToken: Number(state.fencingToken || 0),
        pid,
        startedAt,
      }),
    })
    const envelope = gatewayEnvelopeOutcome(result.stdout)
    journal('execution_process_settled', {
      dispatchId: dispatch.id,
      bindingId: state.bindingId,
      gatewayRunId: liveness.activeGatewayRunId,
      terminationCause: result.terminationCause,
      exitCode: result.code ?? null,
      signal: result.signal ?? null,
      stdoutBytes: result.stdoutBytes ?? 0,
      stderrBytes: result.stderrBytes ?? 0,
      gatewayStatus: envelope.status,
      gatewayStopReason: envelope.stopReason,
      gatewayAborted: envelope.aborted,
      cancellationRequested: liveness.cancellation?.requested === true,
    })
    // A durable cancellation request is authoritative even when the OpenClaw
    // CLI exits zero with a structured `status=timeout, stopReason=aborted`
    // envelope. Process exit zero means the RPC completed; it does not mean the
    // agent Run completed successfully. Never let ordinary completion win once
    // cancellation intent has crossed the durable Helm boundary.
    if (liveness.cancellation?.requested === true) {
      await settleCancellationAuthority(liveness.cancellation)
      const { terminalCode, terminalSummary: summary } = classifyCancellationTerminal(liveness.cancellation)
      journal('cancellation_terminal_selected', {
        dispatchId: dispatch.id,
        bindingId: state.bindingId,
        gatewayRunId: liveness.activeGatewayRunId,
        requestedAt: liveness.cancellation.requestedAt,
        cancellationResolved: liveness.cancellation.resolved === true,
        gatewayCancelled: liveness.cancellation.cancelled === true,
        providerStarted: liveness.cancellation.providerStarted,
        terminalCode,
      })
      await postEventImpl(state, finalEvent(state, dispatch, summary, true))
      await acknowledgeImpl(state, dispatch, { protocolVersion: PROTOCOL, dispatchId: dispatch.id,
        state: 'failed', terminalCode, terminalSummary: summary }, liveness)
      return
    }
    if (result.terminationCause !== 'completed') {
      const terminalByCause = {
        parent_timeout: ['openclaw_parent_timeout', 'OpenClaw advisory exceeded its parent deadline; no customer content produced.'],
        stdout_overflow: ['openclaw_stdout_overflow', 'OpenClaw stdout exceeded its bound; no customer content produced.'],
        stderr_overflow: ['openclaw_stderr_overflow', 'OpenClaw stderr exceeded its bound; no customer content produced.'],
        signal_exit: ['openclaw_signal_exit', 'OpenClaw exited by signal; no customer content produced.'],
        nonzero_exit: ['openclaw_nonzero_exit', 'OpenClaw exited nonzero; no customer content produced.'],
        spawn_error: ['openclaw_spawn_error', 'OpenClaw could not be spawned; no customer content produced.'],
        close_timeout: ['openclaw_close_timeout', 'OpenClaw did not close within its external bound; no customer content produced.'],
      }
      const [terminalCode, genericSummary] = terminalByCause[result.terminationCause] || ['openclaw_failed', 'OpenClaw advisory failed; no customer content produced.']
      const runtimeDetail = result.terminationCause === 'nonzero_exit'
        ? sanitizeRuntimeError(result.stderr)
        : ''
      const summary = runtimeDetail
        ? `OpenClaw exited nonzero: ${runtimeDetail}`.slice(0, 500)
        : genericSummary
      await postEventImpl(state, finalEvent(state, dispatch, summary, true))
      await acknowledgeImpl(state, dispatch, { protocolVersion: PROTOCOL, dispatchId: dispatch.id, state: 'failed', terminalCode, terminalSummary: summary }, liveness)
    } else {
      // HFA-004 — extractText requires structured output; if OpenClaw
      // produced no parseable response frame the run is treated as a
      // controlled failure rather than posting stdout to the customer.
      const finalText = extractStructuredText(result.stdout)
      if (!finalText) {
        const summary = 'OpenClaw returned no structured response frame; no customer content produced.'
        await postEventImpl(state, finalEvent(state, dispatch, summary, true))
        await acknowledgeImpl(state, dispatch, {
          protocolVersion: PROTOCOL,
          dispatchId: dispatch.id,
          state: 'failed',
          terminalCode: 'openclaw_unstructured',
          terminalSummary: summary,
        }, liveness)
      } else {
        // OpenClaw 2026.7.1 emits one JSON envelope at process completion,
        // not NDJSON streaming frames. Emit one bounded structured delta so
        // the protocol remains status -> delta -> final -> ack.
        await postEventImpl(state, deltaEvent(state, dispatch, finalText.slice(0, 20000)))
        await postEventImpl(state, finalEvent(state, dispatch, finalText, false, extractStructuredModel(result.stdout)))
        // HFA-004 — exact locked recovery transcript literal.
        await acknowledgeImpl(state, dispatch, { protocolVersion: PROTOCOL, dispatchId: dispatch.id, state: 'completed', terminalCode: null, terminalSummary: 'Connector recovery passed' }, liveness)
      }
    }
  } catch (error) {
    // Once a dispatch is claimed, every failure must converge through the
    // same durable terminal boundary. If acknowledgement intent already
    // exists, leave it untouched for restart-safe idempotent delivery.
    const hasTerminalIntent = pendingTerminalOutbox(root)
      .some((acknowledgement) => acknowledgement.dispatchId === dispatch.id)
      || Boolean(state.pendingAcks?.[dispatch.id])
    if (!readTerminalRecord(root, dispatch.id) && !hasTerminalIntent) {
      const detail = error instanceof Error ? error.message : String(error)
      const terminalCode = phase === 'admission'
        ? lane === 'run' ? 'helm_link_run_contract_invalid' : 'helm_link_chat_admission_failed'
        : phase === 'claim-registration' ? 'helm_link_claim_registration_failed' : 'openclaw_invocation_failed'
      const summary = `Claimed ${lane} dispatch failed during ${phase}: ${detail}`.slice(0, 500)
      journal('post_claim_terminal_selected', {
        dispatchId: dispatch.id,
        bindingId: state.bindingId,
        phase,
        terminalCode,
      })
      try {
        await postEventImpl(state, finalEvent(state, dispatch, summary, true))
      } catch (eventError) {
        journal('terminal_event_delivery_failed', {
          dispatchId: dispatch.id,
          bindingId: state.bindingId,
          errorCode: eventError?.code || null,
        })
      }
      await acknowledgeImpl(state, dispatch, {
        protocolVersion: PROTOCOL,
        dispatchId: dispatch.id,
        state: 'failed',
        terminalCode,
        terminalSummary: summary,
      }, liveness)
      return
    }
    throw error
  } finally {
    try {
      if (invocation) await runBoundedCleanup(invocation.cleanup)
    } finally {
      liveness.activeDispatchId = null
      liveness.activeGatewayRunId = null
      liveness.cancellation = null
      liveness.activeDispatchStartedAt = null
      delete state.activeInvocationId
    }
  }
}

export async function registerInvocationClaim(state, claim, { postImpl = postJson } = {}) {
  return postImpl(state, '/api/helm-link/connector/claims', {
    protocolVersion: PROTOCOL,
    dispatchId: claim.dispatchId,
    invocationId: claim.invocationId,
    fencingToken: claim.fencingToken,
  })
}

export async function runOpenClawAdvisory({
  args,
  binary = resolveOpenClaw(),
  timeoutMs = 125000,
  env = process.env,
  lifecycle = () => {},
  onSpawn = () => {},
  outputLimit = 1_000_000,
  stderrLimit = 250_000,
  sigtermGraceMs = 2_000,
  closeTimeoutMs = 2_000,
  spawnImpl = spawn,
} = {}) {
  if (!Array.isArray(args)) throw new Error('OpenClaw advisory args are required.')
  return new Promise((resolve, reject) => {
    const startedMonotonicMs = performance.now()
    const startedAt = new Date().toISOString()
    let child
    try {
      child = spawnImpl(binary, args, {
        env: { ...env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      lifecycle('spawn_error', { errorCode: error?.code || null })
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let firstStdoutAt = null
    let firstStderrAt = null
    let timedOut = false
    let stdoutTruncated = false
    let stderrTruncated = false
    let terminationCause = null
    let timerIdentity = null
    let settled = false
    let runtimeTimer = null
    let forceTimer = null
    let closeTimer = null
    lifecycle('spawned', { pid: child.pid || null, startedAt })
    try {
      onSpawn({ pid: child.pid || null, startedAt })
    } catch (error) {
      lifecycle('spawn_state_error', { pid: child.pid || null, errorCode: error?.code || null })
      child.once('error', () => {})
      child.kill('SIGKILL')
      reject(error)
      return
    }
    const appendBounded = (stream, current, chunk) => {
      const bytes = Buffer.byteLength(chunk)
      if (stream === 'stdout') {
        stdoutBytes += bytes
        if (!firstStdoutAt) firstStdoutAt = new Date().toISOString()
      } else {
        stderrBytes += bytes
        if (!firstStderrAt) firstStderrAt = new Date().toISOString()
      }
      const retainedBytes = Buffer.byteLength(current, 'utf8')
      const limit = stream === 'stdout' ? outputLimit : stderrLimit
      const remaining = Math.max(0, limit - retainedBytes)
      if (bytes <= remaining) return current + chunk.toString()
      if (stream === 'stdout') stdoutTruncated = true
      else stderrTruncated = true
      terminate(stream === 'stdout' ? 'stdout_overflow' : 'stderr_overflow', `${stream}_limit`)
      return current + chunk.subarray(0, remaining).toString()
    }
    child.stdout.on('data', (chunk) => { stdout = appendBounded('stdout', stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = appendBounded('stderr', stderr, chunk) })
    const diagnostics = (code, signal, cause = terminationCause) => ({
      code: code ?? (cause === 'completed' ? 0 : 1), signal, timedOut,
      overflow: stdoutTruncated || stderrTruncated, stdout, stderr, stdoutBytes, stderrBytes,
      stdoutTruncated, stderrTruncated, firstStdoutAt, firstStderrAt, startedAt,
      durationMs: Number((performance.now() - startedMonotonicMs).toFixed(3)),
      timerIdentity, terminationCause: cause,
    })
    const settle = (code, signal, cause = terminationCause) => {
      if (settled) return
      settled = true
      clearTimeout(runtimeTimer)
      clearTimeout(forceTimer)
      clearTimeout(closeTimer)
      const result = diagnostics(code, signal, cause)
      lifecycle('child_closed', diagnosticsWithoutContent(result))
      resolve(result)
    }
    const terminate = (cause, timer) => {
      if (terminationCause) return
      terminationCause = cause
      timerIdentity = timer
      lifecycle('signal_sent', { signal: 'SIGTERM', timerIdentity: timer })
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => {
        lifecycle('signal_sent', { signal: 'SIGKILL', timerIdentity: 'sigterm_grace' })
        child.kill('SIGKILL')
      }, sigtermGraceMs)
      closeTimer = setTimeout(() => settle(null, null, 'close_timeout'), sigtermGraceMs + closeTimeoutMs)
    }
    child.once('error', (error) => {
      lifecycle('spawn_error', { errorCode: error?.code || null })
      terminationCause = 'spawn_error'
      settle(null, null, 'spawn_error')
    })
    runtimeTimer = setTimeout(() => {
      timedOut = true
      terminate('parent_timeout', 'runtime_deadline')
    }, timeoutMs)
    child.once('close', (code, signal) => {
      const cause = terminationCause || (signal ? 'signal_exit' : code === 0 ? 'completed' : 'nonzero_exit')
      settle(code, signal, cause)
    })
  })
}

export async function runBoundedCleanup(cleanup, timeoutMs = 2_000) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Invocation cleanup exceeded its external deadline.')
          error.code = 'helm_link_cleanup_timeout'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function diagnosticsWithoutContent(result) {
  const { stdout: _stdout, stderr: _stderr, ...diagnostics } = result
  return diagnostics
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
    event: {
      protocolVersion: PROTOCOL,
      dispatchId: dispatch.id,
      messageId: dispatch.messageId,
      eventId: unsigned.eventId,
      sequence,
      kind,
      body,
      previousHash,
      eventHash: hash,
      occurredAt,
      // Blocker 1: fence authorization must be signed. Present the current
      // ownership epoch inside the signed event body; the server never
      // authorizes from the unsigned `x-helm-link-fencing-token` header.
      deliveryFencingToken: Number(state.fencingToken || 0),
    },
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
      // OpenClaw 2026.7.1 `agent --json` envelope. Only the documented
      // customer payload field is accepted; metadata and raw/visible-text
      // mirrors are deliberately ignored.
      if (parsed.status === 'ok' && Array.isArray(parsed.result?.payloads)) {
        const payloadText = parsed.result.payloads
          .map((payload) => payload && typeof payload === 'object' ? payload.text : null)
          .filter((value) => typeof value === 'string' && value.trim())
        if (payloadText.length) return sanitizeCustomerText(payloadText.join('\n'), 100000)
        return ''
      }
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
    if (parsed.status === 'ok' && Array.isArray(parsed.result?.payloads)) {
      const model = parsed.result?.meta?.agentMeta?.model
      if (typeof model === 'string' && /^[a-z0-9._:/+-]{1,200}$/i.test(model.trim())) return model.trim()
      return null
    }
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
  migrateProcessedLedger(STATE_DIR, state)
  try {
    await acquireBindingFence(state)
    // A connector restart must converge durable terminal intent before it may
    // acquire new work. Failure is terminal for this process attempt: the
    // supervisor can retry, but the acquisition loop never opens while a
    // terminal boundary is unresolved.
    await convergeStartupTerminals(
      state,
      listInvocationClaims(STATE_DIR),
      {
        lastPollCompletedAt: 0, lastDispatchProgressAt: 0,
        activeDispatchId: null, queueDepth: 0,
      },
    )
    try {
      await preflightOpenClawAgentCompatibility()
      if (state.openclawCompatibilityFailure) {
        delete state.openclawCompatibilityFailure
        saveState(state)
      }
    } catch (error) {
      state.openclawCompatibilityFailure = {
        code: 'openclaw_agent_cli_incompatible',
        summary: sanitizeRuntimeError(error instanceof Error ? error.message : String(error), 500),
        observedAt: new Date().toISOString(),
      }
      saveState(state)
      throw error
    }
    await runConnectorLoops(state)
  } catch (error) {
    throw mapTerminalConnectorError(error, state)
  }
}

export function mapTerminalConnectorError(error, state, { persist = saveState } = {}) {
  if (!isTerminalConnectorError(error)) return error
  state.status = 'revoked'
  state.revokedAt = state.revokedAt || new Date().toISOString()
  persist(state)
  error.exitCode = 75
  return error
}

export async function runConnectorLoops(state, options = {}) {
  const postImpl = options.postImpl || postJson
  const controlPostImpl = options.controlPostImpl || postControlJson
  const handleImpl = options.handleImpl || handleDispatch
  const presenceImpl = options.presenceImpl || presence
  const telemetryImpl = options.telemetryImpl || collectTelemetry
  const sleepImpl = options.sleepImpl || sleep
  const signal = options.signal
  const idlePollMs = options.idlePollMs ?? 5_000
  const busyCheckMs = options.busyCheckMs ?? 100
  const presenceMs = options.presenceMs ?? 30_000
  const telemetryMs = options.telemetryMs ?? 30_000
  const telemetryTimeoutMs = options.telemetryTimeoutMs ?? 40_000
  const cancellationMs = options.cancellationMs ?? 250
  const liveness = {
    lastPollCompletedAt: 0, pollStartedAt: 0, lastDispatchProgressAt: 0,
    activeDispatchId: null, activeGatewayRunId: null, activeDispatchStartedAt: null,
    cancellation: null, queueDepth: 0,
  }
  const queue = []
  const telemetry = { openclawVersion: null, runtimeModel: null, updatedAt: null }
  let executing = false
  const stopped = () => signal?.aborted === true
  const pause = (ms) => stopped() ? Promise.resolve() : sleepImpl(ms)

  const acquisitionLoop = async () => {
    while (!stopped()) {
      try {
        const localCapacity = executing || queue.length ? 0 : 1
        liveness.pollStartedAt = Date.now()
        const body = await postImpl(state, '/api/helm-link/connector/poll', {
          protocolVersion: PROTOCOL,
          localCapacity,
          admissionContract: 'openclaw-agent-lane-v1',
          runtimeState: telemetry.runtimeState || 'unknown',
          runtimeStateObservedAt: telemetry.updatedAt,
        })
        liveness.lastPollCompletedAt = Date.now()
        liveness.queueDepth = Number(body.queueDepth || 0)
        if (body.dispatch && localCapacity === 0) throw new Error('Server dispatched work at zero local capacity.')
        if (body.dispatch) queue.push(body.dispatch)
        else await pause(body.retryAfterMs ?? idlePollMs)
      } catch (error) {
        if (isTerminalConnectorError(error)) throw error
        console.error(`[helm-link] acquisition failed: ${error.message}`)
        await pause(idlePollMs)
      } finally { liveness.pollStartedAt = 0 }
    }
  }
  const executionLoop = async () => {
    while (!stopped()) {
      const dispatch = queue.shift()
      if (!dispatch) { await pause(busyCheckMs); continue }
      executing = true
      liveness.queueDepth = Math.max(0, liveness.queueDepth - 1)
      try { await handleImpl(state, dispatch, liveness) }
      catch (error) { console.error(`[helm-link] execution failed: ${error.message}`) }
      finally { executing = false }
    }
  }
  const presenceLoop = async () => {
    while (!stopped()) {
      try {
        await presenceImpl(state, liveness, deriveLivenessPresence(liveness), telemetry)
        state.lastSuccessfulHeartbeatAt = new Date().toISOString()
        saveState(state)
      }
      catch (error) { console.error(`[helm-link] presence failed: ${error.message}`) }
      await pause(presenceMs)
    }
  }
  const telemetryLoop = async () => {
    while (!stopped()) {
      try {
        const next = await withDeadline(telemetryImpl(state), telemetryTimeoutMs, 'telemetry')
        Object.assign(telemetry, next, { updatedAt: new Date().toISOString() })
      } catch (error) { console.error(`[helm-link] telemetry failed: ${error.message}`) }
      await pause(telemetryMs)
    }
  }
  const cancellationLoop = async () => {
    let lastRequestedAt = null
    const journal = createLifecycleJournal(LIFECYCLE_FILE)
    while (!stopped()) {
      try {
        if (liveness.activeDispatchId) {
          const body = await controlPostImpl(state, '/api/helm-link/connector/cancellations', {
            protocolVersion: PROTOCOL,
            dispatchId: liveness.activeDispatchId,
          })
          if (body.cancellation?.requestedAt && body.cancellation.requestedAt !== lastRequestedAt) {
            lastRequestedAt = body.cancellation.requestedAt
            journal('cancellation_request_observed', {
              dispatchId: liveness.activeDispatchId,
              bindingId: state.bindingId,
              gatewayRunId: liveness.activeGatewayRunId,
              requestedAt: body.cancellation.requestedAt,
            })
            // Publish cancellation intent before awaiting Gateway. The original
            // child may terminate first; that race must enter the same absorbing
            // terminal path as a completed cancel response, never the generic
            // process-failure path.
            await requestGatewayCancellation(state, liveness, body.cancellation.requestedAt, {
              cancelImpl: options.cancelImpl || cancelGatewayAgentRun,
              lifecycle: (kind, fields) => journal(kind, {
                dispatchId: liveness.activeDispatchId,
                bindingId: state.bindingId,
                gatewayRunId: liveness.activeGatewayRunId,
                ...fields,
              }),
            })
          }
        } else lastRequestedAt = null
      } catch (error) { console.error(`[helm-link] cancellation check failed: ${error.message}`) }
      await pause(cancellationMs)
    }
  }
  await Promise.all([acquisitionLoop(), executionLoop(), presenceLoop(), telemetryLoop(), cancellationLoop()])
}

export async function requestGatewayCancellation(state, liveness, requestedAt, {
  cancelImpl = cancelGatewayAgentRun,
  lifecycle = () => {},
} = {}) {
  const cancellation = {
    requested: true,
    requestedAt,
    resolved: false,
    cancelled: false,
    providerStarted: null,
  }
  // Synchronous publication is the race boundary: handleDispatch can now see
  // intent even if the original child exits before agent.cancel returns.
  liveness.cancellation = cancellation
  try {
    lifecycle('gateway_cancel_request_started', { requestedAt })
    const outcome = await cancelImpl(state, liveness.activeGatewayRunId)
    Object.assign(cancellation, outcome, { resolved: true })
    lifecycle('gateway_cancel_response', {
      requestedAt,
      cancelled: cancellation.cancelled === true,
      providerStarted: cancellation.providerStarted,
      status: typeof cancellation.status === 'string' ? cancellation.status : null,
    })
  } catch (error) {
    Object.assign(cancellation, { resolved: true, error: error?.message || String(error) })
    lifecycle('gateway_cancel_error', {
      requestedAt,
      errorName: error?.name || 'Error',
      errorCode: error?.code || null,
    })
  }
  return cancellation
}

export async function cancelGatewayAgentRun(state, runId, { runImpl = runOpenClawAdvisory } = {}) {
  const result = await runImpl({
    args: ['gateway', 'call', 'agent.cancel', '--params', JSON.stringify({
      runId,
      agentId: state.runtimeAgentId,
      sessionKey: `agent:${state.runtimeAgentId}:helm-run:${state.bindingId}:${runId}`,
    }), '--json', '--timeout', '5000'],
    timeoutMs: 7_000,
    outputLimit: 50_000,
    stderrLimit: 25_000,
  })
  if (result.terminationCause !== 'completed') return { cancelled: false, providerStarted: null }
  try {
    const parsed = JSON.parse(result.stdout)
    return parsed?.payload ?? parsed?.result ?? parsed
  } catch {
    return { cancelled: false, providerStarted: null }
  }
}

async function collectTelemetry(state) {
  const [versionResult, agentsResult] = await Promise.all([
    runOpenClawAdvisory({ args: ['--version'], timeoutMs: 10_000, outputLimit: 10_000, stderrLimit: 10_000 }),
    runOpenClawAdvisory({ args: ['agents', 'list', '--json'], timeoutMs: 30_000, outputLimit: 250_000, stderrLimit: 50_000 }),
  ])
  let runtimeModel = null
  if (agentsResult.terminationCause === 'completed') {
    try {
      const parsed = JSON.parse(agentsResult.stdout)
      const agents = Array.isArray(parsed) ? parsed : parsed.agents || []
      const agent = agents.find((item) => String(item.id || item.agentId || item.name) === state.runtimeAgentId)
      const configured = String(agent?.model ?? agent?.modelId ?? '').trim()
      if (configured) runtimeModel = { configured, provider: configured.split('/')[0] || 'unknown' }
    } catch {}
  }
  return {
    openclawVersion: versionResult.terminationCause === 'completed' ? versionResult.stdout.trim().slice(0, 120) : null,
    runtimeModel,
    // Stored-session recency and process existence are not capacity signals.
    // OpenClaw 2026.7.1 exposes no supported agent-level in-flight primitive.
    runtimeState: 'unknown',
  }
}

function withDeadline(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function isTerminalConnectorError(error) {
  return error?.status === 403 || error?.status === 410 || /revoked/i.test(error?.message || '')
}

export async function acquireBindingFence(state, { postImpl = postJson, persist = saveState } = {}) {
  const response = await postImpl(state, '/api/helm-link/connector/ownership', {
    protocolVersion: PROTOCOL,
  })
  const fencingToken = Number(response?.fencingToken)
  if (!Number.isSafeInteger(fencingToken) || fencingToken <= Number(state.fencingToken || 0)) {
    throw new Error('Server returned a non-monotonic fencing token.')
  }
  state.fencingToken = fencingToken
  state.fenceIssuedAt = response.issuedAt || new Date().toISOString()
  persist(state)
  return fencingToken
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function status() {
  const state = loadState()
  const service = platform() === 'darwin' ? connectorStatus() : null
  console.log(JSON.stringify(state ? {
    connected: service ? service.connected : false,
    locallyPaired: state.status === 'paired',
    serverReachable: service ? service.serverReachable : false,
    heartbeatAccepted: service ? service.heartbeatAccepted : false,
    processRunning: service ? service.processRunning : false,
    serviceEnabled: service ? service.serviceEnabled : false,
    runtimeComplete: service ? service.runtimeComplete : false,
    server: state.server,
    bindingId: state.bindingId,
    runtimeAgentId: state.runtimeAgentId,
    helmAgentId: state.helmAgentId,
    keyId: state.keyId,
    connectorVersion: VERSION,
    lastSuccessfulHeartbeatAt: state.lastSuccessfulHeartbeatAt || null,
    actionableFailureReason: service?.actionableFailureReason || null,
    stateFile: STATE_FILE,
  } : { connected: false, locallyPaired: false, stateFile: STATE_FILE }, null, 2))
  if (service && !service.connected) process.exitCode = 1
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
    else if (cmd === 'install-service') console.log(JSON.stringify(installService(), null, 2))
    else if (cmd === 'uninstall-service') console.log(JSON.stringify(uninstallService(), null, 2))
    else if (cmd === 'service-status') serviceStatus()
    else if (cmd === 'run') await runLoop()
    else if (cmd === 'status') await status()
    else if (cmd === 'disconnect') await disconnect()
    else usage(2)
  } catch (error) {
    console.error(error.message)
    process.exit(Number.isInteger(error.exitCode) ? error.exitCode : 1)
  }
}
