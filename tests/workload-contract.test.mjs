#!/usr/bin/env node
import assert from 'node:assert/strict'
import { classifyWorkloadText, validateRunContract } from '../packages/helm-link-connector/lib/workload-contract.mjs'
import { advisoryArgs, operationalArgs } from '../packages/helm-link-connector/bin/helm-link.mjs'

assert.equal(classifyWorkloadText('What are the tradeoffs of this architecture?').lane, 'chat')
assert.equal(classifyWorkloadText('Build the architecture branch and run the test suite.').lane, 'run')
assert.throws(() => advisoryArgs('agent', 'binding', 'Build this feature.', { noToolsAttested: true }), /durable Helm Link Run/)
assert.throws(() => advisoryArgs('agent', 'binding', 'Explain this.', { noToolsAttested: false }), /host-attested no-tools/)
const chat = advisoryArgs('agent', 'binding', 'Explain this.', { noToolsAttested: true })
chat.cleanup()
const run = operationalArgs('agent', 'binding', 'dispatch', 'Build this feature.', validateRunContract({
  kind: 'run', capabilities: ['filesystem'], deadlineMs: 60_000,
  cancellation: 'terminal-no-replay', progress: 'durable-events', output: 'durable-terminal',
}))
assert.match(run.args.join(' '), /helm-run:binding:dispatch/)
assert.equal(run.timeoutMs, 65_000)
run.cleanup()
console.log('VERIFIED advisory Chat requires no-tools attestation and operational work requires a durable Run')
