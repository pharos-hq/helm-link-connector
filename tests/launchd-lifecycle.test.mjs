#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'helm-link-launchd-'))
const stateDir = join(root, 'state')
const launchAgents = join(root, 'LaunchAgents')
const launchctlLog = join(root, 'launchctl.log')
const fakeLaunchctl = join(root, 'launchctl')
const fakeOpenClaw = resolve('tests/fixtures/fake-openclaw.mjs')

writeFileSync(fakeLaunchctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${launchctlLog}"\nexit 0\n`, { mode: 0o700 })
chmodSync(fakeLaunchctl, 0o700)

process.env.HELM_LINK_STATE_DIR = stateDir
process.env.HELM_LINK_LAUNCH_AGENTS_DIR = launchAgents
process.env.HELM_LINK_LAUNCHCTL_BIN = fakeLaunchctl
process.env.HELM_LINK_OPENCLAW_BIN = fakeOpenClaw

const { installService } = await import('../packages/helm-link-connector/bin/helm-link.mjs')
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ status: 'paired' }), { mode: 0o600 })

const first = installService({ platformName: 'darwin' })
const second = installService({ platformName: 'darwin' })
assert.equal(first.installed, true)
assert.equal(second.version, '0.2.0-architecture.2')

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

console.log('VERIFIED idempotent launchd install, RunAtLoad, and transient crash recovery contract')
