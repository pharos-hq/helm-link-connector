#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'helm-link-launchd-'))
const stateDir = join(root, 'state')
const launchAgents = join(root, 'LaunchAgents')
const launchctlLog = join(root, 'launchctl.log')
const fakeLaunchctl = join(root, 'launchctl')
const fakeOpenClaw = resolve('tests/fixtures/fake-openclaw.mjs')

writeFileSync(fakeLaunchctl, `#!/bin/sh
printf '%s\\n' "$*" >> "${launchctlLog}"
if [ "$1" = "print" ]; then
  if [ -n "$HELM_LINK_FAKE_LAUNCHD_PID" ]; then
    printf 'state = running\\n'
    printf 'pid = %s\\n' "$HELM_LINK_FAKE_LAUNCHD_PID"
    exit 0
  fi
  printf 'state = exited\\n'
  exit 0
fi
exit 0
`, { mode: 0o700 })
chmodSync(fakeLaunchctl, 0o700)

process.env.HELM_LINK_STATE_DIR = stateDir
process.env.HELM_LINK_LAUNCH_AGENTS_DIR = launchAgents
process.env.HELM_LINK_LAUNCHCTL_BIN = fakeLaunchctl
process.env.HELM_LINK_OPENCLAW_BIN = fakeOpenClaw

const { connectorStatus, installService, uninstallService } = await import('../packages/helm-link-connector/bin/helm-link.mjs')
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ status: 'paired' }), { mode: 0o600 })

const first = installService({ platformName: 'darwin' })
const second = installService({ platformName: 'darwin' })
assert.equal(first.installed, true)
assert.equal(second.version, '0.2.1')
assert.equal(existsSync(join(stateDir, 'runtime', '0.2.1', 'bin', 'helm-link.mjs')), true)
assert.equal(existsSync(join(stateDir, 'runtime', '0.2.1', 'lib', 'lifecycle-journal.mjs')), true)

const plist = readFileSync(first.plist, 'utf8')
assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/)
assert.match(plist, /HELM_LINK_STATE_DIR/)
assert.match(plist, /HELM_LINK_OPENCLAW_BIN/)
assert.match(plist, /<key>PATH<\/key><string>[^<]*node[^<]*<\/string>/)
assert.match(plist, /<key>PATH<\/key><string>[^<]*tests\/fixtures[^<]*<\/string>/)

const servicePath = [dirname(process.execPath), dirname(fakeOpenClaw), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
const launchdOpenClaw = spawnSync(fakeOpenClaw, ['--version'], {
  encoding: 'utf8',
  env: { PATH: servicePath },
})
assert.equal(launchdOpenClaw.status, 0, launchdOpenClaw.stderr)

const calls = readFileSync(launchctlLog, 'utf8')
assert.match(calls, /bootout gui\/\d+\/com\.pharos\.helm-link/)
assert.match(calls, /bootstrap gui\/\d+ .*com\.pharos\.helm-link\.plist/)
assert.match(calls, /enable gui\/\d+\/com\.pharos\.helm-link/)
assert.match(calls, /kickstart -k gui\/\d+\/com\.pharos\.helm-link/)
assert.ok(
  calls.indexOf(`enable gui/${process.getuid()}/com.pharos.helm-link`) <
    calls.indexOf(`bootstrap gui/${process.getuid()}`),
  'disabled launchd label must be enabled before bootstrap',
)

const staleStatus = connectorStatus({ platformName: 'darwin' })
assert.equal(staleStatus.connected, false)
assert.equal(staleStatus.installed, true)
assert.equal(staleStatus.processRunning, false)
assert.match(staleStatus.actionableFailureReason, /not running/i)

process.env.HELM_LINK_FAKE_LAUNCHD_PID = String(process.pid)
writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
  status: 'paired',
  runtimeAgentId: 'forge',
  helmAgentId: '00000000-0000-4000-8000-000000000071',
  bindingId: '00000000-0000-4000-8000-000000000172',
  lastSuccessfulHeartbeatAt: new Date().toISOString(),
}), { mode: 0o600 })
const liveStatus = connectorStatus({ platformName: 'darwin' })
assert.equal(liveStatus.connected, true)
assert.equal(liveStatus.processRunning, true)
assert.equal(liveStatus.serverReachable, true)
assert.equal(liveStatus.boundRuntimeAgentId, 'forge')
assert.equal(liveStatus.connectorVersion, '0.2.1')

const uninstall = uninstallService({ platformName: 'darwin' })
assert.equal(uninstall.uninstalled, true)

const finalCalls = readFileSync(launchctlLog, 'utf8')
assert.match(finalCalls, /bootout gui\/\d+\/com\.pharos\.helm-link/)

console.log('VERIFIED idempotent launchd install, disabled-label recovery ordering, runtime closure, truthful service status, and transient crash recovery contract')
