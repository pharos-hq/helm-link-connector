#!/usr/bin/env node
import assert from 'node:assert/strict'
import { classifyWorkloadText, validateRunContract } from '../packages/helm-link-connector/lib/workload-contract.mjs'
import { advisoryArgs, operationalArgs } from '../packages/helm-link-connector/bin/helm-link.mjs'

assert.equal(classifyWorkloadText('What are the tradeoffs of this architecture?').lane, 'chat')
assert.equal(classifyWorkloadText('Build the architecture branch and run the test suite.').lane, 'run')
assert.throws(() => advisoryArgs('agent', 'binding', 'Build this feature.', { noToolsAttested: true }), /durable Helm Link Run/)
const ordinaryChat = advisoryArgs('agent', 'binding', 'Build a clear explanation of the tradeoffs.', { noToolsAttested: false })
ordinaryChat.cleanup()
const chat = advisoryArgs('agent', 'binding', 'Explain this.', { noToolsAttested: true })
chat.cleanup()
const run = operationalArgs('agent', 'binding', 'dispatch', 'Build this feature.', validateRunContract({
  kind: 'run', capabilities: ['filesystem'], deadlineMs: 60_000,
  cancellation: 'terminal-no-replay', progress: 'durable-events', output: 'durable-terminal',
}), new Date(Date.now() + 60_000).toISOString())
assert.match(run.args.join(' '), /helm-run:binding:dispatch/)
assert.equal(run.timeoutMs, 65_000)
run.cleanup()
console.log('VERIFIED explicit Chat accepts ordinary host-governed agents while attested no-tools mode stays strict')
