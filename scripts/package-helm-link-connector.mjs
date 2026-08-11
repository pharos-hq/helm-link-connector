#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Build the immutable 0.2.8 release archive. The package must contain every
// file, including all lib/*.mjs modules the CLI imports. A partial mirror is
// not acceptable.
const EXPECTED_FILES = [
  'package/LICENSE',
  'package/README.md',
  'package/bin/helm-link.mjs',
  'package/lib/artifact-contract.mjs',
  'package/lib/artifact-outbox.mjs',
  'package/lib/invocation-claims.mjs',
  'package/lib/lifecycle-journal.mjs',
  'package/lib/terminal-store.mjs',
  'package/lib/workload-contract.mjs',
  'package/package.json',
  'package/supervisors/container/docker-compose.yml',
  'package/supervisors/launchd/com.helm.link.plist',
  'package/supervisors/run-supervised.sh',
  'package/supervisors/systemd/helm-link.service',
]

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out-dir')
const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : 'dist/helm-link-connector')
if (outIndex >= 0 && !args[outIndex + 1]) throw new Error('--out-dir requires a path')
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true, mode: 0o755 })

const packed = spawnSync('npm', [
  'pack',
  './packages/helm-link-connector',
  '--pack-destination',
  outDir,
  '--json',
], { cwd: process.cwd(), encoding: 'utf8' })
if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed')

const metadata = JSON.parse(packed.stdout)
if (!Array.isArray(metadata) || metadata.length !== 1 || !metadata[0]?.filename) {
  throw new Error('npm pack returned unexpected metadata')
}
const filename = basename(metadata[0].filename)
const artifactPath = resolve(outDir, filename)
const files = (metadata[0].files ?? []).map((entry) => `package/${entry.path}`).sort()
if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
  throw new Error(`Unexpected package contents: ${files.join(', ')}`)
}

// npm pack is authoritative for the publish allowlist, but npm/tar versions
// encode archive metadata differently. Re-emit those exact declared files as
// canonical ustar so macOS and Linux produce identical bytes.
const canonicalEntries = [
  { archivePath: 'package/package.json', sourcePath: 'packages/helm-link-connector/package.json', mode: 0o644 },
  { archivePath: 'package/LICENSE', sourcePath: 'packages/helm-link-connector/LICENSE', mode: 0o644 },
  { archivePath: 'package/README.md', sourcePath: 'packages/helm-link-connector/README.md', mode: 0o644 },
  { archivePath: 'package/bin/helm-link.mjs', sourcePath: 'packages/helm-link-connector/bin/helm-link.mjs', mode: 0o755 },
  { archivePath: 'package/lib/artifact-contract.mjs', sourcePath: 'packages/helm-link-connector/lib/artifact-contract.mjs', mode: 0o644 },
  { archivePath: 'package/lib/artifact-outbox.mjs', sourcePath: 'packages/helm-link-connector/lib/artifact-outbox.mjs', mode: 0o644 },
  { archivePath: 'package/lib/invocation-claims.mjs', sourcePath: 'packages/helm-link-connector/lib/invocation-claims.mjs', mode: 0o644 },
  { archivePath: 'package/lib/lifecycle-journal.mjs', sourcePath: 'packages/helm-link-connector/lib/lifecycle-journal.mjs', mode: 0o644 },
  { archivePath: 'package/lib/terminal-store.mjs', sourcePath: 'packages/helm-link-connector/lib/terminal-store.mjs', mode: 0o644 },
  { archivePath: 'package/lib/workload-contract.mjs', sourcePath: 'packages/helm-link-connector/lib/workload-contract.mjs', mode: 0o644 },
  { archivePath: 'package/supervisors/container/docker-compose.yml', sourcePath: 'packages/helm-link-connector/supervisors/container/docker-compose.yml', mode: 0o644 },
  { archivePath: 'package/supervisors/launchd/com.helm.link.plist', sourcePath: 'packages/helm-link-connector/supervisors/launchd/com.helm.link.plist', mode: 0o644 },
  { archivePath: 'package/supervisors/run-supervised.sh', sourcePath: 'packages/helm-link-connector/supervisors/run-supervised.sh', mode: 0o755 },
  { archivePath: 'package/supervisors/systemd/helm-link.service', sourcePath: 'packages/helm-link-connector/supervisors/systemd/helm-link.service', mode: 0o644 },
]
const tar = Buffer.concat([
  ...canonicalEntries.flatMap((entry) => tarEntry(entry.archivePath, readFileSync(entry.sourcePath), entry.mode)),
  Buffer.alloc(1024),
])
const compressed = deterministicGzip(tar)
writeFileSync(artifactPath, compressed, { mode: 0o644 })

const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
writeFileSync(resolve(outDir, 'SHA256SUMS'), `${sha256}  ${filename}\n`, { mode: 0o644 })
writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify({
  package: metadata[0].name,
  version: metadata[0].version,
  filename,
  sha256,
  files,
}, null, 2)}\n`, { mode: 0o644 })

console.log(JSON.stringify({ outDir, filename, sha256, files }))

function tarEntry(name, body, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar path is too long: ${name}`)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  writeOctal(header, mode, 100, 8)
  writeOctal(header, 0, 108, 8)
  writeOctal(header, 0, 116, 8)
  writeOctal(header, body.length, 124, 12)
  writeOctal(header, 0, 136, 12)
  header.fill(0x20, 148, 156)
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write('root', 265, 32, 'ascii')
  header.write('root', 297, 32, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const encoded = checksum.toString(8).padStart(6, '0')
  header.write(encoded, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return [header, body, padding]
}

function writeOctal(buffer, value, offset, length) {
  const encoded = value.toString(8).padStart(length - 1, '0')
  if (encoded.length >= length) throw new Error(`Tar numeric field overflow: ${value}`)
  buffer.write(encoded, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function deterministicGzip(body) {
  // A standards-compliant gzip stream using uncompressed DEFLATE blocks.
  // Avoiding host zlib entirely makes the bytes stable across zlib versions.
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff])
  const blocks = []
  for (let offset = 0; offset < body.length; offset += 0xffff) {
    const chunk = body.subarray(offset, Math.min(offset + 0xffff, body.length))
    const final = offset + chunk.length >= body.length
    const block = Buffer.alloc(5 + chunk.length)
    block[0] = final ? 0x01 : 0x00
    block.writeUInt16LE(chunk.length, 1)
    block.writeUInt16LE((~chunk.length) & 0xffff, 3)
    chunk.copy(block, 5)
    blocks.push(block)
  }
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(body), 0)
  trailer.writeUInt32LE(body.length >>> 0, 4)
  return Buffer.concat([header, ...blocks, trailer])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
