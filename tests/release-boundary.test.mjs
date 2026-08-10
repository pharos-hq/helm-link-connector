#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'SOURCE_MANIFEST.json'), 'utf8'))
const temporaryDirectories = []

try {
  assert.equal(manifest.package, '@pharos-hq/helm-link-connector')
  assert.equal(manifest.version, '0.2.6')
  assert.equal(Object.keys(manifest.files).length, 12)

  const expectedFiles = [
    'package/LICENSE',
    'package/README.md',
    'package/bin/helm-link.mjs',
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

  const first = packageOnce()
  const second = packageOnce()
  assert.ok(first.archive.equals(second.archive), 'archives are not reproducible')
  assert.deepEqual(first.files, expectedFiles)

  assert.notEqual(manifest.archive.sha256, 'PENDING_REPRODUCIBLE_BUILD')
  assert.equal(first.hash, manifest.archive.sha256, 'archive SHA-256 drifted from pinned manifest value')
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    assert.notEqual(expectedHash, 'PENDING_REPRODUCIBLE_BUILD', `unpinned source hash: ${relativePath}`)
    const body = readFileSync(join(root, relativePath))
    const actualHash = createHash('sha256').update(body).digest('hex')
    assert.equal(actualHash, expectedHash, `source drift: ${relativePath}`)
  }

  const workflow = readFileSync(
    join(root, '.github/workflows/publish-helm-link-connector.yml'),
    'utf8',
  )
  assert.match(workflow, /tags:\s*\n\s*- 'helm-link-connector-v\*'/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /--provenance/)
  assert.doesNotMatch(workflow, /0\.2\.1-architecture\.\d+/,
    'architecture candidate must not appear in the publication workflow')
  assert.doesNotMatch(
    workflow,
    /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|npm login|npm adduser/,
  )
  assert.match(workflow, /pharos-hq-helm-link-connector-0\.2\.6\.tgz/)
  assert.match(workflow, new RegExp(manifest.archive.sha256))
  assert.match(workflow, /npm install --ignore-scripts --no-audit --no-fund --prefer-online --cache "\$cache_root" --prefix "\$install_root" '@pharos-hq\/helm-link-connector@0\.2\.6'/)
  assert.match(workflow, /helm-link" doctor --agent fixture-agent/)

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

  const packedLifecycleRoot = temporaryDirectory('helm-link-packed-lifecycle-')
  const packedStateDir = join(packedLifecycleRoot, 'state')
  const packedLaunchAgents = join(packedLifecycleRoot, 'LaunchAgents')
  const packedLaunchctlLog = join(packedLifecycleRoot, 'launchctl.log')
  const fakeLaunchctl = join(packedLifecycleRoot, 'launchctl')
  mkdirSync(packedStateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(packedStateDir, 'state.json'), JSON.stringify({
    status: 'paired',
    runtimeAgentId: 'forge',
    helmAgentId: '00000000-0000-4000-8000-000000000071',
    bindingId: '00000000-0000-4000-8000-000000000172',
  }), { mode: 0o600 })
  writeFileSync(fakeLaunchctl, `#!/bin/sh
printf '%s\\n' "$*" >> "${packedLaunchctlLog}"
if [ "$1" = "print-disabled" ]; then
  printf 'disabled services = {\\n'
  if [ "$HELM_LINK_FAKE_LAUNCHD_DISABLED" = "1" ]; then
    printf '  "com.pharos.helm-link" => disabled\\n'
  else
    printf '  "com.pharos.helm-link" => enabled\\n'
  fi
  printf '}\\n'
  exit 0
fi
if [ "$1" = "print" ]; then
  if [ "$HELM_LINK_FAKE_LAUNCHD_NOT_FOUND" = "1" ]; then
    printf 'Could not find service "com.pharos.helm-link" in domain for uid\\n' >&2
    exit 113
  fi
  printf 'state = exited\\n'
  exit 0
fi
exit 0
`, { mode: 0o700 })
  chmodSync(fakeLaunchctl, 0o700)
  const lifecycleEnv = {
    ...process.env,
    HELM_LINK_STATE_DIR: packedStateDir,
    HELM_LINK_LAUNCH_AGENTS_DIR: packedLaunchAgents,
    HELM_LINK_LAUNCHCTL_BIN: fakeLaunchctl,
    HELM_LINK_OPENCLAW_BIN: fixture,
  }
  const installedCli = join(installRoot, 'node_modules/.bin/helm-link')
  for (const [key, value] of Object.entries(lifecycleEnv)) process.env[key] = value
  const packedModule = await import(join(installRoot, 'node_modules/@pharos-hq/helm-link-connector/bin/helm-link.mjs'))
  const packedInstall = packedModule.installService({ platformName: 'darwin' })
  assert.equal(packedInstall.installed, true)
  const packedRuntimeDependency = join(packedStateDir, 'runtime', '0.2.6', 'lib', 'lifecycle-journal.mjs')
  assert.equal(existsSync(packedRuntimeDependency), true)
  process.env.HELM_LINK_FAKE_LAUNCHD_DISABLED = '1'
  process.env.HELM_LINK_FAKE_LAUNCHD_NOT_FOUND = '1'
  const disabledNotFoundStatus = packedModule.connectorStatus({ platformName: 'darwin' })
  assert.equal(disabledNotFoundStatus.connected, false)
  assert.equal(disabledNotFoundStatus.installed, true)
  assert.equal(disabledNotFoundStatus.serviceEnabled, false)
  assert.equal(disabledNotFoundStatus.processRunning, false)
  assert.equal(disabledNotFoundStatus.pid, null)
  assert.match(disabledNotFoundStatus.actionableFailureReason, /disabled/i)
  delete process.env.HELM_LINK_FAKE_LAUNCHD_DISABLED
  delete process.env.HELM_LINK_FAKE_LAUNCHD_NOT_FOUND
  const stoppedStatusJson = packedModule.connectorStatus({ platformName: 'darwin' })
  assert.equal(stoppedStatusJson.connected, false)
  assert.equal(stoppedStatusJson.installed, true)
  assert.equal(stoppedStatusJson.serviceEnabled, true)
  assert.equal(stoppedStatusJson.processRunning, false)
  assert.equal(stoppedStatusJson.heartbeatAccepted, false)
  assert.equal(stoppedStatusJson.runtimeComplete, true)
  unlinkSync(packedRuntimeDependency)
  const missingRuntimeJson = packedModule.connectorStatus({ platformName: 'darwin' })
  assert.equal(missingRuntimeJson.connected, false)
  assert.equal(missingRuntimeJson.runtimeComplete, false)
  assert.match(missingRuntimeJson.actionableFailureReason, /runtime is incomplete/i)

  console.log('VERIFIED source manifest declares 12 audited package files')
  console.log('VERIFIED release candidate 0.2.6 is wired only to tag-bound publication')
  console.log(`VERIFIED reproducible release SHA-256: ${first.hash}`)
  console.log('VERIFIED tokenless tag-bound OIDC workflow at 0.2.6')
  console.log('VERIFIED exact cold-cache registry install gate')
  console.log('VERIFIED installed CLI doctor contract')
  console.log('VERIFIED packed artifact lifecycle detects stopped service and missing runtime dependency')
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
