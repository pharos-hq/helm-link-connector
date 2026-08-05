#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'SOURCE_MANIFEST.json'), 'utf8'))
const temporaryDirectories = []

try {
  assert.equal(manifest.package, '@pharos-hq/helm-link-connector')
  assert.equal(manifest.version, '0.1.8')
  assert.equal(
    manifest.archive.sha256,
    '695c33d439733ce5a414db967541c754639860ed733f10db850f10e5e3289833',
  )
  assert.equal(Object.keys(manifest.files).length, 8)

  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const body = readFileSync(join(root, relativePath))
    const actualHash = createHash('sha256').update(body).digest('hex')
    assert.equal(actualHash, expectedHash, `source drift: ${relativePath}`)
  }

  const first = packageOnce()
  const second = packageOnce()
  assert.equal(first.hash, manifest.archive.sha256)
  assert.equal(second.hash, manifest.archive.sha256)
  assert.ok(first.archive.equals(second.archive), 'archives are not reproducible')
  assert.deepEqual(first.files, [
    'package/LICENSE',
    'package/README.md',
    'package/bin/helm-link.mjs',
    'package/package.json',
    'package/supervisors/container/docker-compose.yml',
    'package/supervisors/launchd/com.helm.link.plist',
    'package/supervisors/run-supervised.sh',
    'package/supervisors/systemd/helm-link.service',
  ])

  const workflow = readFileSync(
    join(root, '.github/workflows/publish-helm-link-connector.yml'),
    'utf8',
  )
  assert.match(workflow, /tags:\s*\n\s*- 'helm-link-connector-v\*'/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /--provenance/)
  assert.match(workflow, /EXPECTED_SHA256/)
  assert.match(workflow, new RegExp(manifest.archive.sha256))
  assert.doesNotMatch(
    workflow,
    /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|npm login|npm adduser/,
  )

  const installRoot = temporaryDirectory('helm-link-install-')
  const install = spawnSync('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    installRoot,
    first.path,
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(install.status, 0, install.stderr)

  const fixture = join(root, 'tests/fixtures/fake-openclaw.mjs')
  chmodSync(fixture, 0o755)
  const doctor = spawnSync(
    join(installRoot, 'node_modules/.bin/helm-link'),
    ['doctor', '--agent', 'fixture-agent'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HELM_LINK_STATE_DIR: join(installRoot, 'state'),
        HELM_LINK_OPENCLAW_BIN: fixture,
      },
    },
  )
  assert.equal(doctor.status, 0, doctor.stderr)
  const doctorResult = JSON.parse(doctor.stdout)
  assert.equal(doctorResult.ok, true)
  assert.deepEqual(
    doctorResult.checks.map(({ name, ok }) => ({ name, ok })),
    [
      { name: 'node_22_plus', ok: true },
      { name: 'os', ok: true },
      { name: 'openclaw_binary', ok: true },
      { name: 'agent_discovery', ok: true },
      { name: 'explicit_agent', ok: true },
      { name: 'state_directory', ok: true },
    ],
  )
  assert.equal(
    doctorResult.checks.find(({ name }) => name === 'explicit_agent')?.detail,
    'fixture-agent',
  )

  console.log('VERIFIED source manifest: 8 audited package files')
  console.log(`VERIFIED release SHA-256: ${first.hash}`)
  console.log('VERIFIED tokenless tag-bound OIDC workflow')
  console.log('VERIFIED installed CLI doctor contract')
} finally {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
}

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function packageOnce() {
  const outputDirectory = temporaryDirectory('helm-link-pack-')
  const result = spawnSync(
    process.execPath,
    ['scripts/package-helm-link-connector.mjs', '--out-dir', outputDirectory],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout.trim())
  const archivePath = join(outputDirectory, output.filename)
  return {
    archive: readFileSync(archivePath),
    files: output.files,
    hash: output.sha256,
    path: archivePath,
  }
}
