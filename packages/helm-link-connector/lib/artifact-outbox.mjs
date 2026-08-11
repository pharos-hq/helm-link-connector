import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function safeId(value) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(value))) throw new Error('Invalid artifact outbox id.')
  return String(value)
}
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flush: true })
  renameSync(temporary, file); syncDirectory(dirname(file))
}
export function artifactIntentPath(root, envelopeId) { return join(root, 'artifact-outbox', `${safeId(envelopeId)}.json`) }
export function writeArtifactIntent(root, intent) {
  const value = { schema: 'helm-link.artifact-outbox.v1', ...intent, envelopeId: safeId(intent.envelopeId) }
  atomicJson(artifactIntentPath(root, value.envelopeId), value)
  return value
}
export function pendingArtifactIntents(root) {
  const directory = join(root, 'artifact-outbox')
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort().flatMap((name) => {
    const value = JSON.parse(readFileSync(join(directory, name), 'utf8'))
    return existsSync(join(root, 'artifact-delivered', `${safeId(value.envelopeId)}.json`)) ? [] : [value]
  })
}
export function markArtifactIntentDelivered(root, envelopeId) {
  const id = safeId(envelopeId)
  const file = join(root, 'artifact-delivered', `${id}.json`)
  if (!existsSync(file)) atomicJson(file, { schema: 'helm-link.artifact-delivered.v1', envelopeId: id, deliveredAt: new Date().toISOString() })
}
