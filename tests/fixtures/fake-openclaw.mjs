#!/usr/bin/env node

const [command, subcommand] = process.argv.slice(2)

if (command === '--version') {
  console.log('fake-openclaw 2026.7.28')
  process.exit(0)
}

if (command === 'agents' && subcommand === 'list') {
  console.log(JSON.stringify({
    agents: [{
      id: 'fixture-agent',
      name: 'Fixture Agent',
      model: 'ollama/fixture-local',
    }],
  }))
  process.exit(0)
}

if (command === 'agent') {
  const scenario = process.env.FAKE_OPENCLAW_SCENARIO || 'structured'
  if (!process.argv.includes('--json')) {
    console.error('missing --json')
    process.exit(3)
  }
  if (scenario === 'structured') {
    console.log(JSON.stringify({
      runId: '00000000-0000-4000-8000-000000000001',
      status: 'ok',
      summary: 'completed',
      result: {
        payloads: [{ text: 'structured customer response' }],
        meta: { agentMeta: { model: 'openai/gpt-fixture' }, finalAssistantRawText: 'ignored raw mirror' },
      },
    }))
    process.exit(0)
  }
  if (scenario === 'zero-content') {
    console.log(JSON.stringify({ status: 'ok', result: { payloads: [], meta: { finalAssistantRawText: 'must not escape' } } }))
    process.exit(0)
  }
  if (scenario === 'malformed') {
    console.log('warning: local configuration at /private/path')
    console.log('plain customer-looking output')
    process.exit(0)
  }
  if (scenario === 'nonzero') {
    console.error('secret diagnostic must not escape')
    process.exit(9)
  }
  if (scenario === 'timeout') {
    await new Promise((resolve) => setTimeout(resolve, 10000))
    process.exit(0)
  }
  if (scenario === 'stdout-overflow') {
    process.stdout.write('x'.repeat(4096))
    await new Promise((resolve) => setTimeout(resolve, 10000))
  }
  if (scenario === 'stderr-overflow') {
    process.stderr.write('x'.repeat(4096))
    await new Promise((resolve) => setTimeout(resolve, 10000))
  }
  if (scenario === 'ignore-sigterm') {
    process.on('SIGTERM', () => {})
    await new Promise(() => setInterval(() => {}, 1000))
  }
}

console.error(`unsupported fake-openclaw command: ${process.argv.slice(2).join(' ')}`)
process.exit(2)
