#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLifecycleRecord, lifecycleRecord } from '../packages/helm-link-connector/lib/lifecycle-journal.mjs'

const root = mkdtempSync(join(tmpdir(), 'helm-link-journal-'))
try {
  const file = join(root, 'nested', 'lifecycle.ndjson')
  const record = lifecycleRecord('spawned', { dispatchId: 'dispatch-fixture' }, {
    utcNow: () => '2026-08-05T14:00:00.000Z',
    monotonicNow: () => 42.125,
  })
  appendLifecycleRecord(file, record)
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows, [{
    schema: 'helm-link.lifecycle.v1',
    kind: 'spawned',
    at: '2026-08-05T14:00:00.000Z',
    monotonicMs: 42.125,
    dispatchId: 'dispatch-fixture',
  }])
  console.log('VERIFIED fsynced append-only lifecycle journal')
} finally {
  rmSync(root, { recursive: true, force: true })
}
