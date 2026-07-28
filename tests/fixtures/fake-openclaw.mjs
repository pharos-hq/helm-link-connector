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

console.error(`unsupported fake-openclaw command: ${process.argv.slice(2).join(' ')}`)
process.exit(2)
