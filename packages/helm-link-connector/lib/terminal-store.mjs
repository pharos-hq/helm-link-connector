import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

function assertId(value) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(value))) throw new Error('Invalid durable record id.')
  return String(value)
}

function syncDirectory(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function exclusiveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  let fd
  try { fd = openSync(file, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') return JSON.parse(readFileSync(file, 'utf8'))
    throw error
  }
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`, null, 'utf8')
    fsyncSync(fd)
  } finally { closeSync(fd) }
  syncDirectory(dirname(file))
  return value
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flush: true })
  renameSync(temporary, file)
  syncDirectory(dirname(file))
}

export function terminalRecordPath(root, dispatchId) {
  return join(root, 'terminals', `${assertId(dispatchId)}.json`)
}

export function readTerminalRecord(root, dispatchId) {
  const file = terminalRecordPath(root, dispatchId)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

export function recordTerminal(root, input) {
  const record = {
    schema: 'helm-link.terminal.v1',
    dispatchId: assertId(input.dispatchId),
    bindingId: assertId(input.bindingId),
    invocationId: input.invocationId ? assertId(input.invocationId) : null,
    invocationFencingToken: Number(input.invocationFencingToken ?? input.fencingToken ?? 0),
    state: input.state,
    terminalCode: input.terminalCode ?? null,
    terminalSummary: String(input.terminalSummary || '').slice(0, 1000),
    terminalAt: input.terminalAt || new Date().toISOString(),
  }
  const stored = exclusiveJson(terminalRecordPath(root, record.dispatchId), record)
  if (stored.state !== record.state || stored.terminalCode !== record.terminalCode) {
    throw new Error(`Terminal record conflict for ${record.dispatchId}`)
  }
  return stored
}

export function writeTerminalOutbox(root, acknowledgement) {
  const dispatchId = assertId(acknowledgement.dispatchId)
  const file = join(root, 'terminal-outbox', `${dispatchId}.json`)
  atomicJson(file, { schema: 'helm-link.terminal-outbox.v1', ...acknowledgement })
  return file
}

export function markTerminalDelivered(root, dispatchId) {
  const id = assertId(dispatchId)
  return exclusiveJson(join(root, 'terminal-delivered', `${id}.json`), {
    schema: 'helm-link.terminal-delivered.v1', dispatchId: id, deliveredAt: new Date().toISOString(),
  })
}

export function pendingTerminalOutbox(root) {
  const dir = join(root, 'terminal-outbox')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort().flatMap((name) => {
    const row = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    return existsSync(join(root, 'terminal-delivered', `${row.dispatchId}.json`)) ? [] : [row]
  })
}

export function migrateProcessedLedger(root, state) {
  const migrated = []
  for (const dispatchId of state.processedDispatchIds || []) {
    if (readTerminalRecord(root, dispatchId)) continue
    migrated.push(recordTerminal(root, {
      dispatchId,
      bindingId: state.bindingId,
      invocationFencingToken: Number(state.fencingToken || 0),
      deliveryFencingToken: Number(state.fencingToken || 0),
      state: 'failed',
      terminalCode: 'legacy_terminal_import',
      terminalSummary: 'Imported from the pre-v2 processed ledger; execution is permanently forbidden.',
    }))
  }
  return migrated
}
