#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  advisoryArgs,
  extractStructuredModel,
  extractStructuredText,
  runOpenClawAdvisory,
} from '../packages/helm-link-connector/bin/helm-link.mjs'

const root = resolve(import.meta.dirname, '..')
const fixture = join(root, 'tests/fixtures/fake-openclaw.mjs')
chmodSync(fixture, 0o755)

const invocation = advisoryArgs('fixture-agent', 'binding-123', 'safe advisory text')
try {
  assert.ok(invocation.args.includes('--json'), 'agent invocation must require structured JSON')
} finally {
  invocation.cleanup()
}

const actualEnvelope = JSON.stringify({
  runId: '00000000-0000-4000-8000-000000000001',
  status: 'ok',
  summary: 'completed',
  result: {
    payloads: [{ text: 'HELM-LINK-083-ACCEPTED' }],
    meta: {
      agentMeta: { model: 'openai/gpt-5.6-sol' },
      finalAssistantVisibleText: 'ignored mirror',
      finalAssistantRawText: 'ignored raw mirror',
    },
  },
})
assert.equal(extractStructuredText(actualEnvelope), 'HELM-LINK-083-ACCEPTED')
assert.equal(extractStructuredModel(actualEnvelope), 'openai/gpt-5.6-sol')

const structured = await runScenario('structured')
assert.equal(structured.code, 0)
assert.equal(structured.timedOut, false)
assert.equal(extractStructuredText(structured.stdout), 'structured customer response')
assert.equal(extractStructuredModel(structured.stdout), 'openai/gpt-fixture')

const malformed = await runScenario('malformed')
assert.equal(malformed.code, 0)
assert.equal(extractStructuredText(malformed.stdout), '')

const nonzero = await runScenario('nonzero')
assert.equal(nonzero.code, 9)
assert.equal(extractStructuredText(nonzero.stdout), '')

const timedOut = await runScenario('timeout', 50)
assert.equal(timedOut.timedOut, true)
assert.equal(extractStructuredText(timedOut.stdout), '')

const zeroContent = await runScenario('zero-content')
assert.equal(zeroContent.code, 0)
assert.equal(extractStructuredText(zeroContent.stdout), '')
assert.ok(!extractStructuredText(zeroContent.stdout).includes('must not escape'))

assert.equal(extractStructuredText('{"status":"ok","result":{"payloads":"not-an-array"}}'), '')
assert.equal(extractStructuredText('raw stdout that resembles customer content'), '')

console.log('VERIFIED OpenClaw 2026.7.1 structured-output contract')
console.log('VERIFIED malformed, non-zero, timeout, and zero-content fail closed')

async function runScenario(scenario, timeoutMs = 2000) {
  return runOpenClawAdvisory({
    binary: fixture,
    args: ['agent', '--agent', 'fixture-agent', '--message', 'fixture', '--json'],
    timeoutMs,
    env: { ...process.env, FAKE_OPENCLAW_SCENARIO: scenario },
  })
}
