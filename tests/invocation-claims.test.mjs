#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimInvocation, readInvocationClaim } from '../packages/helm-link-connector/lib/invocation-claims.mjs'

const root = mkdtempSync(join(tmpdir(), 'helm-link-claims-'))
const input = {
  dispatchId: 'dispatch-immutable',
  bindingId: 'binding-fixture',
  fencingToken: 7,
  invocationId: 'invocation-first',
}
try {
  const first = claimInvocation(root, input)
  assert.equal(first.state, 'invocation_claimed')
  assert.deepEqual(readInvocationClaim(root, input.dispatchId), first)
  assert.throws(
    () => claimInvocation(root, { ...input, invocationId: 'invocation-second' }),
    (error) => error?.code === 'helm_link_invocation_already_claimed',
  )
  // Re-opening through a fresh read simulates restart: the durable claim is
  // still authoritative and the dispatch is not eligible to spawn.
  assert.equal(readInvocationClaim(root, input.dispatchId)?.invocationId, 'invocation-first')
  console.log('VERIFIED fsynced pre-spawn claim and permanent duplicate-spawn denial')
} finally {
  rmSync(root, { recursive: true, force: true })
}
