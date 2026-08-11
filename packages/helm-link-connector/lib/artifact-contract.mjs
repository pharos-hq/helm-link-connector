import { createHash, randomUUID, sign } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute } from 'node:path'

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
export const MAX_ARTIFACT_ENVELOPE_BYTES = 50 * 1024 * 1024

const MIME_BY_EXTENSION = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  json: 'application/json',
  md: 'text/markdown',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
}

export function extractStructuredArtifactDeclarations(stdout) {
  let parsed
  try { parsed = JSON.parse(String(stdout).trim()) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const candidates = []
  if (Array.isArray(parsed.artifacts)) candidates.push(...parsed.artifacts)
  if (Array.isArray(parsed.result?.artifacts)) candidates.push(...parsed.result.artifacts)
  for (const payload of Array.isArray(parsed.result?.payloads) ? parsed.result.payloads : []) {
    if (payload && typeof payload === 'object' && Array.isArray(payload.artifacts)) candidates.push(...payload.artifacts)
  }
  if (candidates.length > 25) throw artifactFailure('openclaw-artifact-count-rejected', 'OpenClaw declared more than 25 output artifacts.')
  const normalized = candidates.map((value, ordinal) => normalizeDeclaration(value, ordinal))
  if (normalized.some((value) => value === null)) {
    throw artifactFailure('openclaw-artifact-declaration-invalid', 'OpenClaw returned an invalid structured artifact declaration.')
  }
  return normalized
}

export function openArtifactOutputRootHandle(outputRoot) {
  if (!outputRoot || !isAbsolute(outputRoot)) {
    throw artifactFailure('openclaw-artifact-root-missing', 'Connector-owned artifact output root is required.')
  }
  let descriptor
  try {
    const pathInfo = lstatSync(outputRoot)
    if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink()) {
      throw artifactFailure('openclaw-artifact-root-invalid', 'Connector-owned artifact output root is invalid.')
    }
    descriptor = openSync(outputRoot, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isDirectory() || opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino) {
      throw artifactFailure('openclaw-artifact-root-raced', 'Connector-owned artifact output root changed during creation.')
    }
    return Object.freeze({ descriptor, dev: opened.dev, ino: opened.ino, path: outputRoot })
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error?.code?.startsWith?.('openclaw-artifact-')) throw error
    throw artifactFailure('openclaw-artifact-root-invalid', 'Connector-owned artifact output root could not be pinned.')
  }
}

export function closeArtifactOutputRootHandle(handle) {
  if (handle?.descriptor !== undefined) closeSync(handle.descriptor)
}

export function prepareArtifactOutputs(declarations, { outputRoot, outputRootHandle, testHooks } = {}) {
  if (!outputRoot || !isAbsolute(outputRoot)) {
    throw artifactFailure('openclaw-artifact-root-missing', 'Connector-owned artifact output root is required.')
  }
  let totalBytes = 0
  return declarations.map((declaration) => {
    const bytes = readBoundedContainedFile(declaration.path, outputRoot, { outputRootHandle, testHooks })
    totalBytes += bytes.length
    if (totalBytes > MAX_ARTIFACT_ENVELOPE_BYTES) {
      throw artifactFailure('openclaw-artifact-envelope-size-rejected', `OpenClaw artifact envelope exceeds ${MAX_ARTIFACT_ENVELOPE_BYTES} bytes.`)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const rawExtension = extname(declaration.filename).slice(1).toLowerCase()
    const extension = rawExtension === 'jpeg' ? 'jpg' : rawExtension
    const mimeType = MIME_BY_EXTENSION[rawExtension]
    if (!mimeType || (declaration.mimeType && declaration.mimeType !== mimeType)) {
      throw artifactFailure('openclaw-artifact-type-rejected', `Unsupported or mismatched OpenClaw artifact type: .${extension || 'unknown'}.`)
    }
    return {
      ordinal: declaration.ordinal,
      transferId: randomUUID(),
      filename: rawExtension === 'jpeg' ? declaration.filename.replace(/\.jpeg$/i, '.jpg') : declaration.filename,
      extension,
      mimeType,
      byteSize: bytes.length,
      sha256,
      bytes,
    }
  })
}

export function readBoundedContainedFile(candidatePath, outputRoot, { outputRootHandle, testHooks = {} } = {}) {
  if (dirname(candidatePath) !== outputRoot) {
    throw artifactFailure('openclaw-artifact-path-outside-root', 'Declared OpenClaw artifact is outside its connector-owned output root.')
  }
  if (!outputRootHandle || outputRootHandle.path !== outputRoot
    || !Number.isInteger(outputRootHandle.descriptor)) {
    throw artifactFailure('openclaw-artifact-root-handle-missing', 'Connector-created artifact output root identity is required.')
  }
  let rootInfo
  let candidateInfo
  let descriptor
  try {
    rootInfo = lstatSync(outputRoot)
    candidateInfo = lstatSync(candidatePath)
    realpathSync(outputRoot)
  } catch (error) {
    if (error?.code?.startsWith?.('openclaw-artifact-')) throw error
    throw artifactFailure('openclaw-artifact-path-unavailable', 'Declared OpenClaw artifact path is unavailable.')
  }
  let pinnedRoot
  try { pinnedRoot = fstatSync(outputRootHandle.descriptor) } catch {
    throw artifactFailure('openclaw-artifact-root-handle-invalid', 'Connector-created artifact output root identity is no longer valid.')
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || !pinnedRoot.isDirectory()
    || rootInfo.dev !== outputRootHandle.dev || rootInfo.ino !== outputRootHandle.ino
    || pinnedRoot.dev !== outputRootHandle.dev || pinnedRoot.ino !== outputRootHandle.ino) {
    throw artifactFailure('openclaw-artifact-root-raced', 'Connector-owned artifact output root changed before custody read.')
  }
  if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) {
    throw artifactFailure('openclaw-artifact-not-regular-file', 'Declared OpenClaw artifact must be a non-symlink regular file.')
  }
  try {
    // The directory descriptor/dev/inode were retained at connector creation.
    // Open only its lexical direct child, then recheck the path still resolves
    // to that pinned directory before consuming the opened file descriptor.
    descriptor = openSync(candidatePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const before = fstatSync(descriptor)
    const rootAfterOpen = lstatSync(outputRoot)
    if (!rootAfterOpen.isDirectory() || rootAfterOpen.isSymbolicLink()
      || rootAfterOpen.dev !== outputRootHandle.dev || rootAfterOpen.ino !== outputRootHandle.ino
      || before.dev !== candidateInfo.dev || before.ino !== candidateInfo.ino) {
      throw artifactFailure('openclaw-artifact-root-raced', 'Connector-owned artifact output root changed during custody open.')
    }
    testHooks.afterRootOpen?.({ outputRoot, rootDescriptor: outputRootHandle.descriptor })
    if (!before.isFile() || before.nlink !== 1) {
      throw artifactFailure('openclaw-artifact-not-regular-file', 'Declared OpenClaw artifact must be a uniquely linked regular file.')
    }
    if (before.size <= 0 || before.size > MAX_ARTIFACT_BYTES) {
      throw artifactFailure('openclaw-artifact-size-rejected', `OpenClaw artifact must be between 1 byte and ${MAX_ARTIFACT_BYTES} bytes.`)
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
      if (read <= 0) throw artifactFailure('openclaw-artifact-short-read', 'Declared OpenClaw artifact changed during custody read.')
      offset += read
    }
    const after = fstatSync(descriptor)
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size) {
      throw artifactFailure('openclaw-artifact-path-raced', 'Declared OpenClaw artifact changed during custody read.')
    }
    return bytes
  } catch (error) {
    if (error?.code?.startsWith?.('openclaw-artifact-')) throw error
    if (error?.code === 'ELOOP') {
      throw artifactFailure('openclaw-artifact-not-regular-file', 'Declared OpenClaw artifact must be a non-symlink regular file.')
    }
    throw artifactFailure('openclaw-artifact-read-denied', 'Declared OpenClaw artifact could not be read safely.')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function buildSignedArtifactEnvelope({ state, dispatch, outputs, model = null, now = new Date() }) {
  const artifactSource = dispatch.payload?.artifactSource
  if (!artifactSource) throw artifactFailure('openclaw-artifact-source-missing', 'Helm did not provide canonical artifact source identity for this dispatch.')
  const source = artifactSource.surface === 'openclaw_chat'
    ? {
        surface: 'openclaw_chat',
        conversationId: artifactSource.conversationId,
        messageId: artifactSource.messageId,
        taskId: null,
        runId: null,
        outputOrdinal: 0,
      }
    : {
        surface: 'openclaw_run',
        conversationId: null,
        messageId: null,
        taskId: artifactSource.taskId,
        runId: artifactSource.runId,
        outputOrdinal: 0,
      }
  const unsigned = {
    version: 'founder-remediation-ii.v1',
    envelopeId: randomUUID(),
    scope: { organizationId: state.tenantId, projectId: artifactSource.projectId ?? null },
    source,
    producer: {
      agentId: state.helmAgentId,
      runtimeKind: 'external_openclaw',
      runtimeAgentId: state.runtimeAgentId,
      model,
    },
    authentication: {
      kind: 'signed_connector',
      bindingId: state.bindingId,
      dispatchId: dispatch.id,
      keyId: state.keyId,
      algorithm: 'ed25519',
    },
    outputs: outputs.map(({ bytes: _bytes, ...output }) => output),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  }
  const detachedSignature = sign(null, Buffer.from(canonical(unsigned)), state.privateKeyPem).toString('base64')
  return { ...unsigned, authentication: { ...unsigned.authentication, detachedSignature } }
}

export function canonicalArtifactEnvelopeForSignature(envelope) {
  const { detachedSignature: _signature, ...authentication } = envelope.authentication || {}
  return canonical({ ...envelope, authentication })
}

function normalizeDeclaration(value, ordinal) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const path = typeof value.path === 'string' ? value.path.trim() : ''
  if (!path || !isAbsolute(path) || /[\u0000-\u001f]/.test(path)) return null
  const requestedName = typeof value.filename === 'string' ? value.filename.trim() : basename(path)
  const filename = requestedName.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255)
  if (!filename || filename === '.' || filename === '..') return null
  return {
    ordinal,
    path,
    filename,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType.trim().toLowerCase() : null,
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  return JSON.stringify(value)
}

function artifactFailure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
