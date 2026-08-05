import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

export const LIFECYCLE_SCHEMA = 'helm-link.lifecycle.v1'

export function lifecycleRecord(kind, fields = {}, clock = {}) {
  return {
    schema: LIFECYCLE_SCHEMA,
    kind,
    at: (clock.utcNow || (() => new Date().toISOString()))(),
    monotonicMs: Number((clock.monotonicNow || (() => performance.now()))().toFixed(3)),
    ...fields,
  }
}

export function appendLifecycleRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const fd = openSync(file, 'a', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return record
}

export function createLifecycleJournal(file, clock) {
  return (kind, fields = {}) => appendLifecycleRecord(file, lifecycleRecord(kind, fields, clock))
}
