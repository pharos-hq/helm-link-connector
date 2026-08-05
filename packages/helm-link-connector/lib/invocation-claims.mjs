import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class InvocationAlreadyClaimedError extends Error {
  constructor(dispatchId) {
    super(`Dispatch has a durable invocation claim and must never spawn again: ${dispatchId}`)
    this.name = 'InvocationAlreadyClaimedError'
    this.code = 'helm_link_invocation_already_claimed'
    this.dispatchId = dispatchId
  }
}

function assertIdentifier(name, value) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(value))) {
    throw new Error(`Invalid ${name}.`)
  }
}

function fsyncDirectory(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function invocationClaimPath(root, dispatchId) {
  assertIdentifier('dispatch id', dispatchId)
  return join(root, 'invocations', `${dispatchId}.json`)
}

export function readInvocationClaim(root, dispatchId) {
  const file = invocationClaimPath(root, dispatchId)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function claimInvocation(root, input) {
  const { dispatchId, bindingId, fencingToken, invocationId } = input
  assertIdentifier('dispatch id', dispatchId)
  assertIdentifier('binding id', bindingId)
  assertIdentifier('invocation id', invocationId)
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 0) throw new Error('Invalid fencing token.')
  const file = invocationClaimPath(root, dispatchId)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const record = {
    schema: 'helm-link.invocation-claim.v1',
    state: 'invocation_claimed',
    dispatchId,
    bindingId,
    fencingToken,
    invocationId,
    claimedAt: new Date().toISOString(),
  }
  let fd
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new InvocationAlreadyClaimedError(dispatchId)
    throw error
  }
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8')
    fsyncSync(fd)
  } catch (error) {
    try { closeSync(fd) } catch {}
    throw error
  }
  closeSync(fd)
  fsyncDirectory(dirname(file))
  return record
}
